"""De registros crudos a prospectos evaluables.

Cuatro pasos, en este orden:

1. **Recolectar.** Se consultan todas las fuentes activas. Ninguna es
   obligatoria: si una falla, se sigue con las demas y se anota la incidencia.
2. **Fusionar.** La misma empresa aparece en varias fuentes con nombres
   distintos ("Cementos Argos S.A." en el registro mercantil, "Argos" en el
   mapa). Se fusionan por parecido de nombre y cercania geografica.
3. **Caracterizar.** Se resuelve el arquetipo sectorial y se estima caudal y
   calidad. La analitica medida de un permiso pisa siempre a la inferencia.
4. **Situar.** Distancia geodesica y longitud estimada de conduccion.

El paso 2 es el que mas valor anade y el que mas facil es hacer mal. Fusionar
de menos duplica prospectos y el optimizador cuenta dos veces la misma agua;
fusionar de mas mezcla la analitica de una empresa con la ubicacion de otra.
Por eso el criterio exige las dos cosas a la vez: nombres parecidos Y a menos
de 600 m. Un solo criterio no basta.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace

from ..domain.water_chem import Calidad
from . import ciiu as ciiu_mod
from . import analitica
from . import dossier
from .fuentes import Fuente, Modo, RegistroCrudo, ResultadoFuente, catalogo
from .geo import (
    PLANTA, RADIO_BUSQUEDA_KM, Corredor, Cruce, Sitio,
    distancia_conduccion_km, haversine_km,
)
from .perfil import Metodo, Prospecto, Referencia
#: Reexportados: son la misma nocion de identidad que usa la fusion.
from .texto import normalizar, parecido

#: Para fusionar hacen falta las dos condiciones a la vez.
UMBRAL_PARECIDO = 0.82
UMBRAL_CERCANIA_KM = 0.6


@dataclass
class _Agregado:
    """Registros de distintas fuentes que se refieren a la misma empresa."""

    registros: list[RegistroCrudo] = field(default_factory=list)

    @property
    def principal(self) -> RegistroCrudo:
        """El registro con mas superficie declarada manda en la geometria.

        La capa cartografica trae poligono; un registro administrativo trae
        a lo sumo un punto de referencia, que suele ser la porteria o la
        direccion fiscal.
        """
        return max(
            self.registros,
            key=lambda r: float(r.atributos.get("area_m2", 0) or 0),
        )

    def atributo(self, clave: str, defecto=None):
        """Primer valor no vacio del atributo entre todos los registros."""
        for r in self.registros:
            valor = r.atributos.get(clave)
            if valor not in (None, "", {}):
                return valor
        return defecto


def _fusionar(registros: list[RegistroCrudo]) -> list[_Agregado]:
    agregados: list[_Agregado] = []
    for r in registros:
        destino = None
        for a in agregados:
            p = a.principal
            if (
                parecido(r.nombre, p.nombre) >= UMBRAL_PARECIDO
                and haversine_km(r.lat, r.lon, p.lat, p.lon)
                <= UMBRAL_CERCANIA_KM
            ):
                destino = a
                break
        if destino is None:
            agregados.append(_Agregado([r]))
        else:
            destino.registros.append(r)
    return agregados


# --------------------------------------------------------------------------
# Trazado
# --------------------------------------------------------------------------

def _inferir_trazado(
    lat: float, lon: float, origen: Sitio,
) -> tuple[Corredor, tuple[Cruce, ...]]:
    """Deduce por que tipo de corredor iria la tuberia.

    Reglas declaradas, no un enrutador: a menos de 1,5 km dentro del mismo
    corredor industrial se asume que existe servidumbre o rack aprovechable;
    hasta 5 km, derecho de via de la carretera; mas alla, servidumbres
    predio a predio. Se anade un cruce de via principal cada ~2,5 km de
    trazado, que es el espaciado tipico de las transversales del corredor.

    Cuando exista el trazado real levantado en campo, esta funcion se
    sustituye por la longitud medida y nada mas cambia.
    """
    d = haversine_km(origen.lat, origen.lon, lat, lon)
    if d <= 1.5:
        corredor = Corredor.RACK_INDUSTRIAL
    elif d <= 5.0:
        corredor = Corredor.VIA_PUBLICA
    else:
        corredor = Corredor.CAMPO_TRAVIESA

    cruces: list[Cruce] = [Cruce.VIA_PRINCIPAL] * max(0, int(d / 2.5))
    # Al oeste del eje del corredor esta la bahia: un prospecto claramente
    # mas al oeste que la planta obliga a bordearla.
    if lon < origen.lon - 0.012:
        cruces.append(Cruce.LINEA_COSTERA)
    return corredor, tuple(cruces)


# --------------------------------------------------------------------------
# Caracterizacion
# --------------------------------------------------------------------------

def _aplicar_medidas(
    calidad: Calidad, medidas: dict[str, float],
) -> tuple[Calidad, frozenset[str]]:
    """Sustituye en la calidad inferida los parametros con analitica real.

    Un permiso de vertimiento trae tipicamente pH, DQO y SST y nada mas. Eso
    no permite construir una caracterizacion completa, pero si corregir la
    del arquetipo en los parametros que si vienen: el resultado es un hibrido
    que se declara como tal via `campos_medidos`.
    """
    validos = {
        k: float(v) for k, v in medidas.items()
        if hasattr(calidad, k) and isinstance(v, (int, float))
    }
    if not validos:
        return calidad, frozenset()
    return replace(calidad, **validos), frozenset(validos)


def _caracterizar(
    agregado: _Agregado, indice: int, origen: Sitio,
) -> Prospecto | None:
    principal = agregado.principal
    codigo_ciiu = str(agregado.atributo("ciiu", "") or "")
    etiquetas = " ".join(
        str(r.atributos.get("etiquetas", "")) for r in agregado.registros
    )
    producto = " ".join(
        str(r.atributos.get("producto", "")) for r in agregado.registros
    )

    # El expediente documental manda sobre la conjetura por texto: si alguien
    # ya investigo que hace esta empresa concreta y lo dejo citado, eso vale
    # mas que adivinar el sector a partir del nombre. Es tambien el unico
    # camino para empresas cuyo nombre no dice nada de su actividad, que en
    # un parque industrial real son la mayoria.
    expediente = dossier.buscar(principal.nombre)
    if expediente is not None:
        arquetipo = ciiu_mod.ARQUETIPOS_POR_CLAVE.get(expediente.arquetipo)
        metodo_sector = dossier.metodo()
        codigo_ciiu = codigo_ciiu or expediente.ciiu
    else:
        arquetipo, metodo_sector = ciiu_mod.resolver(
            ciiu=codigo_ciiu, nombre=principal.nombre,
            etiquetas=f"{etiquetas} {producto}",
        )
    if arquetipo is None:
        # Sin arquetipo no hay nada que decir del agua. Se descarta: es mas
        # honesto que inventar una caracterizacion generica.
        return None

    # -- caudal --------------------------------------------------------
    declarado = agregado.atributo("caudal_m3_h")
    if declarado:
        caudal = float(declarado)
        metodo_caudal = Metodo.DECLARADO
    else:
        area = float(agregado.atributo("area_m2", 0) or 0)
        caudal = ciiu_mod.caudal_estimado(arquetipo, area)
        metodo_caudal = Metodo.INFERIDO

    # -- calidad -------------------------------------------------------
    medidas = agregado.atributo("calidad_medida", {}) or {}
    calidad, medidos = _aplicar_medidas(arquetipo.calidad, dict(medidas))
    metodo_calidad = metodo_sector if not medidos else Metodo.DECLARADO

    # Una analitica de laboratorio pisa a todo lo anterior, parametro por
    # parametro. Lo que el laboratorio no midio se queda como estaba: un
    # informe sigue la Resolucion 0631, que no exige todos los parametros que
    # necesita el balance de una torre.
    lab = analitica.buscar(principal.nombre)
    if lab is not None:
        calidad, de_lab = lab.aplicar(calidad)
        if de_lab:
            medidos = medidos | de_lab
            metodo_calidad = analitica.metodo()
        if lab.caudal_m3_h:
            caudal = lab.caudal_m3_h
            metodo_caudal = analitica.metodo()

    # -- geometria -----------------------------------------------------
    corredor, cruces = _inferir_trazado(principal.lat, principal.lon, origen)
    recta, trazado = distancia_conduccion_km(
        principal.lat, principal.lon, corredor, cruces, origen,
    )

    referencias = tuple(
        Referencia(
            fuente=r.fuente,
            identificador=r.identificador,
            descripcion=r.nombre,
            url=r.url,
        )
        for r in agregado.registros
    ) + (
        Referencia(
            fuente="ciiu",
            identificador=arquetipo.clave,
            descripcion=f"Arquetipo sectorial: {arquetipo.nombre}",
        ),
    ) + (
        (
            Referencia(
                fuente="analitica",
                identificador=lab.informe,
                descripcion=(
                    f"{lab.punto} - {lab.laboratorio}, "
                    f"{lab.muestras} muestras compuestas"
                ),
                url="https://vital-publico.minambiente.gov.co/buscador",
                consultado=lab.fecha,
            ),
        ) if lab is not None else ()
    ) + tuple(
        Referencia(
            fuente="dossier",
            identificador=expediente.razon_social,
            descripcion=expediente.actividad,
            url=url,
        )
        for url in (expediente.fuentes if expediente is not None else ())
    )

    return Prospecto(
        codigo=f"P{indice:02d}",
        nombre=principal.nombre,
        sector=arquetipo.nombre,
        ciiu=codigo_ciiu or "/".join(arquetipo.ciiu[:2]),
        corriente=arquetipo.corriente,
        lat=principal.lat,
        lon=principal.lon,
        distancia_linea_km=recta,
        distancia_conduccion_km=trazado,
        caudal_m3_h=caudal,
        calidad=calidad,
        metodo_caudal=metodo_caudal,
        metodo_calidad=metodo_calidad,
        campos_medidos=medidos,
        incentivo_usd_m3=arquetipo.incentivo_usd_m3,
        referencias=referencias,
        limitante=arquetipo.limitante,
        notas=(
            f"Trazado por {corredor.value.replace('_', ' ')}"
            + (f", {len(cruces)} cruce(s) singular(es)" if cruces else "")
            + (f" | {expediente.escala}" if expediente is not None else "")
        ),
    )


# --------------------------------------------------------------------------
# Orquestacion
# --------------------------------------------------------------------------

@dataclass
class Barrido:
    """Resultado completo de una prospeccion."""

    prospectos: list[Prospecto]
    fuentes: list[ResultadoFuente]
    origen: Sitio
    radio_km: float
    #: Registros que se recolectaron pero no llegaron a prospecto.
    descartados: int = 0

    @property
    def caudal_total_m3_h(self) -> float:
        return round(sum(p.caudal_m3_h for p in self.prospectos), 1)


def prospectar(
    origen: Sitio = PLANTA,
    radio_km: float = RADIO_BUSQUEDA_KM,
    fuentes: list[Fuente] | None = None,
    #: Excluye a la propia planta del resultado: se encuentra a si misma.
    excluir: tuple[str, ...] = ("cabot",),
    #: Modo de consulta para este barrido; None = el de la configuracion.
    modo: Modo | None = None,
) -> Barrido:
    activas = catalogo() if fuentes is None else fuentes
    resultados = [
        f.consultar(origen.lat, origen.lon, radio_km, modo=modo)
        if modo is not None else f.consultar(origen.lat, origen.lon, radio_km)
        for f in activas
    ]

    crudos: list[RegistroCrudo] = []
    for r in resultados:
        crudos.extend(r.registros)

    # Fuera lo que este fuera del radio y la propia planta.
    dentro = [
        c for c in crudos
        if haversine_km(origen.lat, origen.lon, c.lat, c.lon) <= radio_km
        and not any(e in normalizar(c.nombre) for e in excluir)
    ]

    agregados = _fusionar(dentro)
    prospectos: list[Prospecto] = []
    descartados = 0
    for i, a in enumerate(agregados, start=1):
        p = _caracterizar(a, i, origen)
        if p is None:
            descartados += 1
        else:
            prospectos.append(p)

    prospectos.sort(key=lambda p: p.distancia_conduccion_km)
    return Barrido(
        prospectos=prospectos, fuentes=resultados, origen=origen,
        radio_km=radio_km, descartados=descartados,
    )
