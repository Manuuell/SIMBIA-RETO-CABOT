"""Modulo de prospeccion: geometria, arquetipos, fusion, puntaje y estado."""

from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from simbia.config import Escenario
from simbia.domain.water_chem import Calidad
from simbia.main import app
from simbia.scout import (
    almacen, analitica, ciiu, dossier, extraccion, geo, permisos, scoring,
    vigilancia,
)
from simbia.scout.fuentes import (
    Fuente, RegistroCrudo, ResultadoFuente, catalogo, modo_actual,
)
from simbia.scout.fuentes.base import Modo
from simbia.scout.fuentes.osm import FuenteOSM
from simbia.scout.perfil import (
    CONFIANZA_METODO, Estado, Metodo, Prospecto, Referencia,
)
from simbia.scout.pipeline import parecido, normalizar, prospectar
from simbia.scout.promocion import (
    UMBRAL_PROMOCION, a_oferente, catalogo_desde_prospectos,
)


# ==========================================================================
# Geometria
# ==========================================================================

def test_la_conduccion_nunca_es_mas_corta_que_la_linea_recta():
    for corredor in geo.Corredor:
        recta, trazado = geo.distancia_conduccion_km(10.33, -75.51, corredor)
        assert trazado >= recta


def test_cada_cruce_singular_alarga_el_trazado():
    _, sin_cruces = geo.distancia_conduccion_km(10.32, -75.50)
    _, con_cruce = geo.distancia_conduccion_km(
        10.32, -75.50, cruces=(geo.Cruce.LINEA_COSTERA,),
    )
    assert con_cruce > sin_cruces


def test_un_corredor_peor_exige_mas_tuberia():
    _, rack = geo.distancia_conduccion_km(
        10.33, -75.51, geo.Corredor.RACK_INDUSTRIAL)
    _, via = geo.distancia_conduccion_km(
        10.33, -75.51, geo.Corredor.VIA_PUBLICA)
    _, campo = geo.distancia_conduccion_km(
        10.33, -75.51, geo.Corredor.CAMPO_TRAVIESA)
    assert rack < via < campo


def test_la_planta_esta_en_el_origen_de_la_proyeccion():
    x, y = geo.proyectar(geo.PLANTA.lat, geo.PLANTA.lon)
    assert abs(x) < 1e-6 and abs(y) < 1e-6


def test_la_proyeccion_conserva_la_distancia_a_escala_de_parque():
    """A pocos km la equirectangular no debe desviarse de la geodesica."""
    lat, lon = 10.34, -75.52
    x, y = geo.proyectar(lat, lon)
    proyectada = (x ** 2 + y ** 2) ** 0.5
    geodesica = geo.haversine_km(geo.PLANTA.lat, geo.PLANTA.lon, lat, lon)
    assert abs(proyectada - geodesica) / geodesica < 0.01


# ==========================================================================
# Arquetipos sectoriales
# ==========================================================================

def test_ningun_codigo_ciiu_esta_en_dos_arquetipos():
    vistos: set[str] = set()
    for a in ciiu.ARQUETIPOS:
        for codigo in a.ciiu:
            assert codigo not in vistos, f"CIIU {codigo} duplicado"
            vistos.add(codigo)


def test_resolver_por_ciiu_es_mas_fiable_que_por_texto():
    _, por_codigo = ciiu.resolver(ciiu="1921")
    _, por_nombre = ciiu.resolver(nombre="Refineria del litoral")
    assert CONFIANZA_METODO[por_codigo] > CONFIANZA_METODO[por_nombre]


def test_sin_pistas_no_se_inventa_un_arquetipo():
    arquetipo, metodo = ciiu.resolver(nombre="Ferreteria Los Dos Hermanos")
    assert arquetipo is None
    assert metodo is Metodo.SUPUESTO


def test_el_caudal_escala_con_el_predio_pero_acotado():
    a = ciiu.ARQUETIPOS_POR_CLAVE["bebidas"]
    minusculo = ciiu.caudal_estimado(a, 100.0)
    referencia = ciiu.caudal_estimado(a, a.area_ref_m2)
    gigante = ciiu.caudal_estimado(a, a.area_ref_m2 * 1000)
    assert minusculo < referencia < gigante
    # El recorte impide que un poligono mal digitalizado produzca un absurdo.
    assert minusculo >= a.caudal_ref_m3_h * 0.3 - 1e-6
    assert gigante <= a.caudal_ref_m3_h * 3.0 + 1e-6


def test_el_rango_de_caudal_contiene_la_estimacion():
    for a in ciiu.ARQUETIPOS:
        bajo, alto = ciiu.rango_caudal(a, a.caudal_ref_m3_h)
        assert bajo <= a.caudal_ref_m3_h <= alto


def test_una_pista_no_casa_dentro_de_otra_palabra():
    """Regresion: con datos reales de Mamonal, "termo" casaba dentro de
    "In-termo-dal" —un patio de contenedores— y lo clasificaba como central
    termica, inventandole una purga de calderas. Una pista simple solo puede
    casar con un token que empiece por ella."""
    assert ciiu.por_texto(
        "Intermodal", "industrial=patio_de_contenedores"
    ).clave == "portuario"
    # La pista sigue capturando lo que si es una central.
    for nombre in ("Termocandelaria", "Termocartagena"):
        assert ciiu.por_texto(nombre, "landuse=industrial").clave == "termoelectrica"


def test_una_subestacion_no_es_una_central():
    """`power=substation` no produce purga de calderas. La pista tiene que
    exigir la etiqueta de central, no la clave `power` a secas."""
    assert ciiu.por_texto(
        "Cospique", "power=substation substation=industrial voltage=66000"
    ) is None
    assert ciiu.por_texto(
        "Central X", "power=plant plant:source=gas"
    ).clave == "termoelectrica"


def test_todos_los_arquetipos_declaran_su_limitante():
    for a in ciiu.ARQUETIPOS:
        assert a.limitante.strip(), f"{a.clave} sin parametro limitante"
        assert 0 < a.cv < 1, f"{a.clave} con coeficiente de variacion absurdo"


# ==========================================================================
# Expedientes documentales
# ==========================================================================

def test_ningun_expediente_entra_sin_fuente():
    """Es la regla que separa una investigacion de una afirmacion."""
    for e in dossier.EXPEDIENTES:
        assert e.fuentes, f"{e.razon_social} sin fuente"
        for url in e.fuentes:
            assert url.startswith("http")


def test_todo_expediente_apunta_a_un_arquetipo_que_existe():
    for e in dossier.EXPEDIENTES:
        assert e.arquetipo in ciiu.ARQUETIPOS_POR_CLAVE, e.arquetipo


def test_el_expediente_reconoce_los_nombres_del_mapa():
    """Los nombres que trae OpenStreetMap, no los de la escritura publica."""
    assert dossier.buscar("Abocol S.A.").arquetipo == "nitrogenados"
    assert dossier.buscar("Mexichem S.A.").arquetipo == "plasticos"
    assert dossier.buscar("Cotecmar").arquetipo == "astillero"


def test_el_expediente_no_casa_dentro_de_otra_palabra():
    """Mismo error de subcadena que ya costo una central termica inventada."""
    assert dossier.buscar("Guayarama S.A.") is None
    assert dossier.buscar("Ferreteria El Tornillo") is None


def test_un_expediente_documentado_no_es_una_medida():
    """Investigar que hace una empresa no es analizar su vertimiento."""
    assert dossier.metodo() is Metodo.DECLARADO
    assert dossier.metodo() is not Metodo.MEDIDO


def test_el_expediente_manda_sobre_la_conjetura_por_texto():
    """"Mexichem" no contiene ninguna pista de sector: sin expediente se
    clasificaria mal o se descartaria. Se usa Mexichem y no Abocol porque
    Abocol ya tiene analitica de laboratorio y sube a MEDIDO, que taparia lo
    que esta prueba quiere comprobar."""
    mapa = _FuenteFalsa("osm", [_registro(
        "osm", "way/9", "Mexichem S.A.", 10.3195, -75.5011,
        area_m2=414_331.0, etiquetas="landuse=industrial",
    )])
    b = prospectar(fuentes=[mapa])
    assert len(b.prospectos) == 1
    p = b.prospectos[0]
    assert p.sector.startswith("Transformacion de plasticos")
    assert p.metodo_calidad is Metodo.DECLARADO
    # Las fuentes consultadas viajan como referencias auditables.
    urls = [r.url for r in p.referencias if r.fuente == "dossier"]
    assert urls and all(u.startswith("http") for u in urls)


def test_el_expediente_no_inventa_caracterizacion_de_agua():
    """Determina el arquetipo; el agua sigue saliendo del modelo sectorial.
    Atribuir un DQO a una empresa nombrada sin medirlo es justo lo que el
    resto del proyecto se niega a hacer."""
    for e in dossier.EXPEDIENTES:
        campos = {f for f in dir(e) if not f.startswith("_")}
        assert "calidad" not in campos
        assert "dqo" not in campos


# ==========================================================================
# Confianza
# ==========================================================================

def _prospecto(**kwargs) -> Prospecto:
    base = dict(
        codigo="P01", nombre="Empresa X", sector="Sector", ciiu="2011",
        corriente="Rechazo", lat=10.32, lon=-75.50,
        distancia_linea_km=1.0, distancia_conduccion_km=1.4,
        caudal_m3_h=30.0, calidad=Calidad(),
    )
    base.update(kwargs)
    return Prospecto(**base)


def test_la_confianza_ordena_los_metodos():
    inferido = _prospecto(metodo_calidad=Metodo.INFERIDO)
    declarado = _prospecto(metodo_calidad=Metodo.DECLARADO)
    medido = _prospecto(metodo_calidad=Metodo.MEDIDO)
    assert inferido.confianza < declarado.confianza < medido.confianza


def test_la_analitica_real_sube_la_confianza():
    sin = _prospecto()
    con = _prospecto(campos_medidos=frozenset({"dqo", "sst", "ph"}))
    assert con.confianza > sin.confianza


def test_la_confianza_nunca_se_sale_de_rango():
    extremo = _prospecto(
        metodo_calidad=Metodo.MEDIDO, metodo_caudal=Metodo.MEDIDO,
        campos_medidos=frozenset(f"p{i}" for i in range(30)),
        estado=Estado.CONTRATADO,
    )
    assert 0.0 <= extremo.confianza <= 1.0


def test_la_calidad_pesa_mas_que_el_caudal_en_la_confianza():
    """Un caudal mal estimado se renegocia; una calidad mal estimada no."""
    buena_calidad = _prospecto(
        metodo_calidad=Metodo.MEDIDO, metodo_caudal=Metodo.INFERIDO)
    buen_caudal = _prospecto(
        metodo_calidad=Metodo.INFERIDO, metodo_caudal=Metodo.MEDIDO)
    assert buena_calidad.confianza > buen_caudal.confianza


# ==========================================================================
# Fuentes
# ==========================================================================

def test_por_defecto_no_se_sale_a_la_red():
    assert modo_actual() is Modo.OFFLINE


def test_en_modo_offline_nunca_se_sale_a_la_red():
    """Offline sirve de la cache, de los ejemplos si estan encendidos, o de
    nada -- lo que no puede es abrir una conexion."""
    for f in catalogo():
        r = f.consultar(geo.PLANTA.lat, geo.PLANTA.lon, 8.0)
        assert r.origen in {"fixture", "cache", "sin dato"}


def test_sin_dato_real_se_devuelve_vacio_y_no_registros_inventados(monkeypatch):
    """Rellenar con ejemplos los deja indistinguibles de los reales en la
    misma tabla. Es preferible el hueco, dicho en voz alta."""
    from simbia.scout.fuentes import base
    monkeypatch.delenv("SIMBIA_SCOUT_EJEMPLOS", raising=False)
    sin_configurar = [f for f in catalogo() if not f.verificada]
    assert sin_configurar
    for f in sin_configurar:
        r = f.consultar(geo.PLANTA.lat, geo.PLANTA.lon, 8.0)
        assert r.registros == []
        assert r.origen == "sin dato"
        assert r.incidencia.strip()


def test_los_ejemplos_se_pueden_encender_a_proposito(monkeypatch):
    monkeypatch.setenv("SIMBIA_SCOUT_EJEMPLOS", "1")
    sin_configurar = [f for f in catalogo() if not f.verificada][0]
    r = sin_configurar.consultar(geo.PLANTA.lat, geo.PLANTA.lon, 8.0)
    assert r.origen == "fixture"
    assert r.registros


def test_un_radio_menor_se_sirve_recortando_la_descarga_mayor(tmp_path, monkeypatch):
    """Pedir 2 km teniendo 8 km descargados no puede dar 'sin dato'.

    La cache se guarda por consulta exacta; sin esto, cambiar el radio en el
    dashboard en modo offline dejaba la prospeccion vacia.
    """
    from simbia.scout.fuentes import base
    monkeypatch.setenv("SIMBIA_SCOUT_MODO", "offline")
    monkeypatch.setattr(base, "CACHE", tmp_path)
    fuente = FuenteOSM()
    lat, lon = geo.PLANTA.lat, geo.PLANTA.lon
    cerca = {"fuente": "osm", "identificador": "a", "nombre": "Cerca S.A.",
             "lat": lat + 0.005, "lon": lon, "atributos": {}, "url": ""}
    lejos = {"fuente": "osm", "identificador": "b", "nombre": "Lejos S.A.",
             "lat": lat + 0.05, "lon": lon, "atributos": {}, "url": ""}
    base.escribir_cache(
        "osm", fuente._clave(lat, lon, 8.0), [cerca, lejos],
        consulta={"lat": lat, "lon": lon, "radio_km": 8.0},
    )
    r = fuente.consultar(lat, lon, 2.0)
    assert r.origen == "cache"
    assert [x.nombre for x in r.registros] == ["Cerca S.A."]
    assert r.ok, "recortar no es una incidencia"
    assert "8 km" in r.nota
    # Un radio mayor que cualquier descarga sigue siendo, honestamente, sin dato.
    assert fuente.consultar(lat, lon, 12.0).origen == "sin dato"
    assert base.descargas_en_cache("osm")[0]["radio_km"] == 8.0


def test_un_dato_real_cacheado_gana_a_la_instantanea_de_ejemplo(tmp_path, monkeypatch):
    """Sin red no se puede refrescar, pero un dato real descargado antes vale
    mas que uno de demostracion. `offline` significa "no salgas a la red", no
    "ignora lo que ya descargaste"."""
    from simbia.scout.fuentes import base
    monkeypatch.setattr(base, "CACHE", tmp_path)
    fuente = catalogo()[0]
    clave = fuente._clave(geo.PLANTA.lat, geo.PLANTA.lon, 8.0)
    base.escribir_cache(fuente.codigo, clave, [{
        "fuente": fuente.codigo, "identificador": "way/1", "nombre": "Real S.A.",
        "lat": geo.PLANTA.lat, "lon": geo.PLANTA.lon,
        "atributos": {"area_m2": 1000.0}, "url": "",
    }])
    r = fuente.consultar(geo.PLANTA.lat, geo.PLANTA.lon, 8.0)
    assert r.origen == "cache"
    assert r.registros[0].nombre == "Real S.A."


def test_una_fuente_sin_configurar_lo_declara():
    """Es preferible decir 'no estoy configurada' que fingir un dato real."""
    sin_verificar = [f for f in catalogo() if not f.verificada]
    assert sin_verificar, "el conector de datos.gov debe venir sin verificar"
    for f in sin_verificar:
        assert f.nota_configuracion.strip()
        r = f.consultar(geo.PLANTA.lat, geo.PLANTA.lon, 8.0)
        assert r.incidencia


def test_los_registros_de_demostracion_van_etiquetados():
    """Nada que parezca un expediente real puede pasar por autentico."""
    from simbia.scout.fuentes.fixtures_mamonal import registros_permisos
    for r in registros_permisos():
        assert r.atributos.get("_demostracion") is True
        assert r.identificador.startswith("EJEMPLO-")


# ==========================================================================
# Fusion de registros
# ==========================================================================

def test_la_normalizacion_ignora_sufijos_societarios_y_tildes():
    assert normalizar("Cementos Argos S.A.") == normalizar("CEMENTOS ARGOS")
    assert normalizar("Petroquímica") == normalizar("Petroquimica")


class _FuenteFalsa(Fuente):
    """Fuente de prueba con registros fijos.

    La primera version de esta prueba corria `prospectar()` a secas y miraba a
    ver si algo se habia fusionado. Dependia de que fuente estuviera activa:
    en cuanto la cache trajo datos reales de OpenStreetMap, los registros de
    ejemplo que se fusionaban dejaron de estar y la prueba se cayo sin que
    hubiera ningun defecto. Una prueba de la logica de fusion tiene que
    controlar sus entradas.
    """

    def __init__(self, codigo, registros):
        self.codigo = codigo
        self.nombre = codigo
        self._registros = registros

    def _clave(self, lat, lon, radio_km):
        return f"{self.codigo}:{lat},{lon},{radio_km}"

    def _fixture(self):
        return self._registros

    def consultar(self, lat, lon, radio_km):
        # Se puentea la orquestacion de modos a proposito: un doble de prueba
        # que dependiera de variables de entorno dejaria de ser un doble.
        from datetime import datetime, timezone
        return ResultadoFuente(
            self.codigo, list(self._registros), "prueba",
            datetime.now(timezone.utc).isoformat(timespec="seconds"),
        )


def _registro(fuente, ident, nombre, lat, lon, **atributos):
    return RegistroCrudo(
        fuente=fuente, identificador=ident, nombre=nombre,
        lat=lat, lon=lon, atributos=atributos,
    )


def test_se_fusiona_la_misma_empresa_vista_por_dos_fuentes():
    mapa = _FuenteFalsa("osm", [_registro(
        "osm", "way/1", "Cerveceria del Caribe S.A.", 10.3200, -75.5000,
        area_m2=45_000.0, etiquetas="industrial=brewery",
    )])
    permisos = _FuenteFalsa("datos_gov", [_registro(
        "datos_gov", "EXP-1", "CERVECERIA DEL CARIBE", 10.3201, -75.5001,
        ciiu="1103", caudal_m3_h=28.0,
        calidad_medida={"dqo": 275.0, "sst": 40.0, "ph": 6.9},
    )])
    b = prospectar(fuentes=[mapa, permisos])

    assert len(b.prospectos) == 1, "las dos vistas de la empresa no se fusionaron"
    p = b.prospectos[0]
    assert {"osm", "datos_gov"} <= {r.fuente for r in p.referencias}
    # La analitica del permiso pisa a la estimacion del arquetipo...
    assert p.campos_medidos == frozenset({"dqo", "sst", "ph"})
    assert p.calidad.dqo == 275.0
    assert p.metodo_calidad is Metodo.DECLARADO
    # ...y el caudal declarado pisa al inferido del area del predio.
    assert p.caudal_m3_h == 28.0
    assert p.metodo_caudal is Metodo.DECLARADO
    # Fusionar eleva la confianza por encima de lo puramente inferido.
    assert p.confianza > CONFIANZA_METODO[Metodo.INFERIDO]


def test_no_se_fusiona_lo_que_solo_se_parece_en_el_nombre():
    """Hacen falta las dos condiciones: parecido Y cercania."""
    lejos = _FuenteFalsa("osm", [
        _registro("osm", "way/1", "Planta Norte S.A.", 10.3200, -75.5000,
                  area_m2=40_000.0, etiquetas="industrial=brewery"),
        _registro("osm", "way/2", "Planta Norte S.A.", 10.3600, -75.5000,
                  area_m2=40_000.0, etiquetas="industrial=brewery"),
    ])
    b = prospectar(fuentes=[lejos], radio_km=10.0)
    assert len(b.prospectos) == 2, "fusiono dos plantas a 4 km de distancia"


def test_no_se_fusionan_empresas_distintas_aunque_esten_cerca():
    b = prospectar()
    nombres = [normalizar(p.nombre) for p in b.prospectos]
    assert len(nombres) == len(set(nombres)), "hay prospectos duplicados"


def test_la_fusion_exige_parecido_y_cercania_a_la_vez():
    """Un solo criterio no basta: fusionaria plantas vecinas distintas."""
    assert parecido("Cementos Argos", "Cementos Argos Planta") > 0.8
    assert parecido("Cementos Argos", "Cerveceria Bavaria") < 0.6


def test_todo_prospecto_cae_dentro_del_radio_pedido():
    b = prospectar(radio_km=2.0)
    for p in b.prospectos:
        d = geo.haversine_km(geo.PLANTA.lat, geo.PLANTA.lon, p.lat, p.lon)
        assert d <= 2.0 + 1e-9


def test_la_planta_no_se_encuentra_a_si_misma():
    b = prospectar()
    assert not any("cabot" in normalizar(p.nombre) for p in b.prospectos)


def test_sin_arquetipo_se_descarta_en_vez_de_inventar_agua():
    b = prospectar()
    assert b.descartados > 0
    for p in b.prospectos:
        assert p.sector, "todo prospecto debe tener sector resuelto"


# ==========================================================================
# Puntaje
# ==========================================================================

@pytest.fixture(scope="module")
def puntuados():
    return scoring.puntuar_todos(prospectar().prospectos)


def test_el_puntaje_esta_acotado_y_ordenado(puntuados):
    for p in puntuados:
        assert 0.0 <= p.puntaje <= 100.0
    puntajes = [p.puntaje for p in puntuados]
    assert puntajes == sorted(puntajes, reverse=True)


def test_el_desglose_suma_el_puntaje_salvo_el_factor_de_confianza(puntuados):
    for p in puntuados:
        if p.puntaje == 0:
            continue
        bruto = sum(p.detalle_puntaje.values())
        factor = 0.55 + 0.45 * p.confianza
        assert p.puntaje == pytest.approx(bruto * factor, abs=0.15)


def test_el_puntaje_no_se_satura_en_ninguno_de_los_dos_extremos(puntuados):
    """La primera version daba cero a diez de dieciocho: no discriminaba."""
    puntajes = [p.puntaje for p in puntuados]
    assert max(puntajes) - min(puntajes) > 15.0
    assert sum(1 for v in puntajes if v == 0) < len(puntajes) / 3


def test_acercar_un_prospecto_no_puede_empeorar_su_puntaje():
    esc = Escenario()
    lejos = _prospecto(
        distancia_conduccion_km=5.0,
        calidad=ciiu.ARQUETIPOS_POR_CLAVE["plasticos"].calidad,
    )
    cerca = replace(lejos, distancia_conduccion_km=0.5)
    assert scoring.puntuar(cerca, esc).puntaje >= scoring.puntuar(lejos, esc).puntaje


def test_agua_mas_salina_puntua_peor_en_igualdad_de_condiciones():
    esc = Escenario()
    limpia = _prospecto(calidad=ciiu.ARQUETIPOS_POR_CLAVE["plasticos"].calidad)
    salina = replace(
        limpia, calidad=ciiu.ARQUETIPOS_POR_CLAVE["petroquimica_desmi"].calidad)
    assert scoring.puntuar(limpia, esc).puntaje > scoring.puntuar(salina, esc).puntaje


def test_el_puntaje_es_determinista():
    esc = Escenario()
    p = _prospecto(calidad=ciiu.ARQUETIPOS_POR_CLAVE["bebidas"].calidad)
    assert scoring.puntuar(p, esc).puntaje == scoring.puntuar(p, esc).puntaje


def test_todo_prospecto_viable_lleva_su_plan_tecnico(puntuados):
    for p in puntuados:
        if p.puntaje > 0:
            assert "Plan:" in p.notas
            assert "ciclos" in p.notas


# ==========================================================================
# Promocion al optimizador
# ==========================================================================

def test_el_umbral_de_confianza_filtra_de_verdad():
    ps = scoring.puntuar_todos(prospectar().prospectos)
    todos = catalogo_desde_prospectos(ps, umbral=0.0)
    exigente = catalogo_desde_prospectos(ps, umbral=0.9)
    assert len(exigente) < len(todos)


def test_la_confianza_viaja_como_disponibilidad_anual():
    poco = a_oferente(_prospecto(metodo_calidad=Metodo.INFERIDO))
    mucho = a_oferente(_prospecto(
        metodo_calidad=Metodo.MEDIDO, metodo_caudal=Metodo.MEDIDO))
    assert poco.disponibilidad < mucho.disponibilidad
    assert 0.0 < poco.disponibilidad <= 1.0


def test_al_optimizador_viaja_el_trazado_y_no_la_linea_recta():
    """Mandarle la geodesica subestimaria el CAPEX de conduccion siempre."""
    p = _prospecto(distancia_linea_km=1.0, distancia_conduccion_km=1.8)
    assert a_oferente(p).distancia_km == 1.8


def test_los_codigos_del_catalogo_promovido_son_unicos():
    ps = scoring.puntuar_todos(prospectar().prospectos)
    codigos = [o.codigo for o in catalogo_desde_prospectos(ps, umbral=0.0)]
    assert len(codigos) == len(set(codigos))


# ==========================================================================
# Estado comercial
# ==========================================================================

def test_la_clave_estable_tolera_variaciones_de_nombre_y_coordenada():
    a = almacen.clave_estable("Cementos Argos S.A.", 10.3081, -75.4952)
    b = almacen.clave_estable("CEMENTOS ARGOS", 10.3082, -75.4951)
    assert a == b


def test_la_clave_estable_distingue_empresas_distintas():
    a = almacen.clave_estable("Cementos Argos", 10.3081, -75.4952)
    b = almacen.clave_estable("Cerveceria Bavaria", 10.3402, -75.4894)
    assert a != b


def test_el_embudo_avanza_de_forma_monotona():
    previo = -1.0
    for etapa in almacen.ORDEN_ESTADO:
        avance = almacen.Ficha(clave="x", estado=etapa).avance
        assert avance > previo
        previo = avance


def test_un_descarte_no_cuenta_como_avance():
    assert almacen.Ficha(clave="x", estado=Estado.DESCARTADO).avance == 0.0


def test_toda_etapa_declara_que_hace_falta_para_salir_de_ella():
    for etapa in Estado:
        assert almacen.REQUISITO_SIGUIENTE[etapa].strip()


def test_la_persistencia_de_fichas_va_y_vuelve(tmp_path, monkeypatch):
    monkeypatch.setattr(almacen, "BASE", tmp_path)
    monkeypatch.setattr(almacen, "ESTADOS", tmp_path / "estado.json")
    f = almacen.actualizar_ficha(
        "abc123", estado=Estado.NDA, responsable="Ana", nombre="Empresa X")
    assert f.estado is Estado.NDA
    recargadas = almacen.cargar_fichas()
    assert recargadas["abc123"].responsable == "Ana"
    assert recargadas["abc123"].historial[-1]["a"] == "nda"


def _almacen_temporal(tmp_path, monkeypatch):
    monkeypatch.setattr(almacen, "BASE", tmp_path)
    monkeypatch.setattr(almacen, "ESTADOS", tmp_path / "estado.json")


def test_una_ficha_con_nombre_antiguo_se_reenlaza_por_parecido(tmp_path, monkeypatch):
    """Lo que paso en el primer barrido real: la ficha se creo con 'Cementos
    Argos' (instantanea de trabajo) y OpenStreetMap la llama 'Argos S.A.'."""
    _almacen_temporal(tmp_path, monkeypatch)
    almacen.actualizar_ficha("clave-vieja", estado=Estado.CONTACTADO,
                             responsable="M. Esteban", nombre="Cementos Argos")
    argos = _prospecto(nombre="Argos S.A.", lat=10.3081, lon=-75.4952)
    otra = _prospecto(nombre="Aguas de Cartagena", lat=10.35, lon=-75.52)
    enlazadas, huerfanas = almacen.vincular_fichas([argos, otra])
    clave_nueva = almacen.clave_estable(argos.nombre, argos.lat, argos.lon)
    assert not huerfanas
    assert enlazadas[clave_nueva].responsable == "M. Esteban"
    # Migrada y guardada: la siguiente vez coincide por clave y con rastro.
    guardadas = almacen.cargar_fichas()
    assert clave_nueva in guardadas and "clave-vieja" not in guardadas
    assert "reenlazada" in guardadas[clave_nueva].historial[-1]["nota"]
    assert guardadas[clave_nueva].lat == argos.lat
    # Y el barrido la ve: el prospecto hereda la etapa.
    assert almacen.aplicar_fichas([argos])[0].estado is Estado.CONTACTADO


def test_una_ficha_ambigua_sin_coordenada_queda_huerfana(tmp_path, monkeypatch):
    """Dos candidatos igual de parecidos y ninguna coordenada que desempate:
    antes que adivinar, se deja para reasignar a mano."""
    _almacen_temporal(tmp_path, monkeypatch)
    almacen.actualizar_ficha("clave-vieja", estado=Estado.NDA, nombre="Argos")
    a = _prospecto(nombre="Argos S.A.", lat=10.30, lon=-75.49)
    b = _prospecto(nombre="Cementos Argos", lat=10.36, lon=-75.53)
    enlazadas, huerfanas = almacen.vincular_fichas([a, b])
    assert not enlazadas and [f.clave for f in huerfanas] == ["clave-vieja"]
    # Con coordenada, gana el mas cercano.
    almacen.actualizar_ficha("clave-vieja", lat=10.3601, lon=-75.5299)
    enlazadas, huerfanas = almacen.vincular_fichas([a, b])
    assert not huerfanas
    assert list(enlazadas) == [almacen.clave_estable(b.nombre, b.lat, b.lon)]


def test_una_ficha_lejana_no_se_reenlaza_aunque_el_nombre_coincida(tmp_path, monkeypatch):
    _almacen_temporal(tmp_path, monkeypatch)
    almacen.actualizar_ficha("clave-vieja", estado=Estado.NDA, nombre="Argos",
                             lat=10.30, lon=-75.49)
    lejos = _prospecto(nombre="Argos S.A.", lat=10.40, lon=-75.60)   # ~16 km
    enlazadas, huerfanas = almacen.vincular_fichas([lejos])
    assert not enlazadas and len(huerfanas) == 1


def test_reasignar_una_ficha_a_mano(tmp_path, monkeypatch):
    _almacen_temporal(tmp_path, monkeypatch)
    almacen.actualizar_ficha("clave-vieja", estado=Estado.PILOTO, nombre="Algo S.A.")
    destino = _prospecto(nombre="Otra Cosa Ltda", lat=10.31, lon=-75.50)
    f = almacen.reasignar_ficha("clave-vieja", destino)
    assert f.estado is Estado.PILOTO and f.nombre == destino.nombre
    assert almacen.aplicar_fichas([destino])[0].estado is Estado.PILOTO
    with pytest.raises(KeyError):
        almacen.reasignar_ficha("no-existe", destino)
    # Al destino con ficha propia no se le pisa nada.
    almacen.actualizar_ficha("suelta", estado=Estado.NDA, nombre="Suelta")
    with pytest.raises(ValueError):
        almacen.reasignar_ficha("suelta", destino)


# ==========================================================================
# Analitica de laboratorio
# ==========================================================================

def test_ninguna_analitica_entra_sin_informe_citado():
    for a in analitica.ANALITICAS:
        assert a.informe.strip() and a.laboratorio.strip()
        assert a.fuente.strip() and a.expediente.strip()
        assert a.muestras >= 1


def test_una_analitica_de_laboratorio_si_es_una_medida():
    assert analitica.metodo() is Metodo.MEDIDO


def test_la_analitica_solo_pisa_lo_que_el_laboratorio_midio():
    """Un informe sigue la Resolucion 0631, que no exige todos los parametros
    que necesita el balance de una torre. Lo no medido se queda inferido."""
    a = analitica.buscar("Abocol S.A.")
    assert a is not None
    base = ciiu.ARQUETIPOS_POR_CLAVE["nitrogenados"].calidad
    nueva, medidos = a.aplicar(base)
    # Lo medido cambia...
    assert nueva.n_amoniacal == a.medido["n_amoniacal"] != base.n_amoniacal
    # ...y lo no medido no se toca ni se inventa.
    assert "cloruros" not in medidos
    assert nueva.cloruros == base.cloruros
    assert "silice" not in medidos
    assert nueva.silice == base.silice


def test_la_analitica_lleva_el_prospecto_a_confianza_maxima():
    b = prospectar()
    abocol = [p for p in b.prospectos if "abocol" in normalizar(p.nombre)]
    assert abocol, "Abocol deberia estar en el barrido"
    p = abocol[0]
    assert p.metodo_calidad is Metodo.MEDIDO
    assert p.metodo_caudal is Metodo.MEDIDO
    assert p.confianza > 0.9
    assert "analitica" in {r.fuente for r in p.referencias}


def test_el_caudal_medido_pisa_al_estimado_por_area():
    """El area del predio estimaba 90 m3/h; el laboratorio midio 38."""
    a = analitica.buscar("Yara Colombia")
    b = prospectar()
    p = [x for x in b.prospectos if "abocol" in normalizar(x.nombre)][0]
    assert p.caudal_m3_h == a.caudal_m3_h


# ==========================================================================
# Permisos de vertimiento (VITAL)
# ==========================================================================

def _permiso_vertimiento(titular, expediente="EXP-1", autoridad="EPA- CARTAGENA"):
    return permisos.Permiso(
        titular=titular, autoridad=autoridad, expediente=expediente,
        tramite="Vertimiento de Aguas", radicado="VDA-00001-25",
        fecha="2025-01-01T00:00:00",
    )


def test_solo_se_conservan_los_tramites_de_vertimiento():
    """El buscador devuelve tambien correspondencia y concesiones, que no
    dicen nada del agua de rechazo."""
    filas = [
        {"tra_nombre": "Vertimiento de Aguas", "nombre_completo": "A",
         "aut_nombre": "EPA- CARTAGENA", "expediente": "1"},
        {"tra_nombre": "Correspondencia", "nombre_completo": "B",
         "aut_nombre": "EPA- CARTAGENA", "expediente": "2"},
        {"tra_nombre": "Concesion de Aguas", "nombre_completo": "C",
         "aut_nombre": "CARDIQUE", "expediente": "3"},
    ]
    salida = permisos._interpretar(filas)
    assert [x.titular for x in salida] == ["A"]


def test_un_permiso_sin_titular_no_sirve_para_cruzar():
    filas = [{"tra_nombre": "Vertimiento de Aguas", "nombre_completo": "",
              "aut_nombre": "EPA- CARTAGENA", "expediente": "1"}]
    assert permisos._interpretar(filas) == []


def test_el_cruce_por_razon_social_tolera_sufijos_societarios():
    lista = [_permiso_vertimiento("LAMITECH  S.A.S.")]
    assert permisos.cruzar("Lamitech", lista)


def test_el_cruce_no_confunde_empresas_distintas():
    """Sin coordenada con la que desempatar, el nombre tiene que bastar."""
    lista = [_permiso_vertimiento("POLYBOL S.A.S")]
    assert not permisos.cruzar("Biofilm", lista)
    assert not permisos.cruzar("Cementos Argos", lista)


def test_el_permiso_sube_la_confianza_pero_menos_que_una_analitica():
    """Saber que alguien vierte no es saber que vierte."""
    base = _prospecto()
    con_permiso = replace(base, referencias=(
        Referencia(fuente="vital", identificador="EXP-1"),
    ))
    con_analitica = replace(base, campos_medidos=frozenset({"dqo", "sst", "ph"}))
    assert base.confianza < con_permiso.confianza < con_analitica.confianza


def test_el_enriquecimiento_no_toca_la_caracterizacion_del_agua():
    """El buscador publica que existe el permiso, no su analitica. Inventarla
    seria exactamente lo que el resto del proyecto se niega a hacer."""
    p = _prospecto(nombre="Lamitech")
    salida, tocados = permisos.enriquecer([p], [_permiso_vertimiento("LAMITECH S.A.S.")])
    assert tocados == 1
    assert salida[0].calidad == p.calidad
    assert salida[0].campos_medidos == p.campos_medidos
    assert salida[0].metodo_calidad is p.metodo_calidad


def test_el_enriquecimiento_deja_el_expediente_para_pedirlo():
    """El numero de expediente es lo que hace accionable un derecho de
    peticion: sin el, la solicitud se pierde."""
    salida, _ = permisos.enriquecer(
        [_prospecto(nombre="Lamitech")],
        [_permiso_vertimiento("LAMITECH S.A.S.", expediente="1070860522056225001")],
    )
    refs = [r for r in salida[0].referencias if r.fuente == "vital"]
    assert refs and refs[0].identificador == "1070860522056225001"
    assert "derecho de peticion" in salida[0].notas


def test_sin_permisos_el_enriquecimiento_no_altera_nada():
    entrada = [_prospecto()]
    salida, tocados = permisos.enriquecer(entrada, [])
    assert tocados == 0
    assert salida == entrada


# ==========================================================================
# Vigilancia
# ==========================================================================

def _instantanea(prospectos):
    return {
        "tomada": "2026-01-01T00:00:00+00:00",
        "prospectos": [
            {
                "clave": almacen.clave_estable(p.nombre, p.lat, p.lon),
                "nombre": p.nombre, "caudal_m3_h": p.caudal_m3_h,
                "confianza": p.confianza, "puntaje": p.puntaje,
                "tds": p.calidad.tds, "dqo": p.calidad.dqo,
            }
            for p in prospectos
        ],
    }


def test_sin_cambios_no_hay_falsos_positivos(puntuados):
    assert vigilancia.comparar(puntuados, _instantanea(puntuados)) == []


def test_se_detecta_una_empresa_nueva(puntuados):
    anterior = _instantanea(puntuados[1:])
    cambios = vigilancia.comparar(puntuados, anterior)
    assert any(c.tipo == "alta" for c in cambios)


def test_se_detecta_una_empresa_que_desaparece(puntuados):
    cambios = vigilancia.comparar(puntuados[1:], _instantanea(puntuados))
    assert any(c.tipo == "baja" for c in cambios)


def test_una_subida_grande_de_caudal_es_severidad_alta(puntuados):
    anterior = _instantanea(puntuados)
    movido = [replace(puntuados[0], caudal_m3_h=puntuados[0].caudal_m3_h * 2)]
    movido += list(puntuados[1:])
    cambios = vigilancia.comparar(movido, anterior)
    caudal = [c for c in cambios if c.tipo == "caudal"]
    assert caudal and caudal[0].severidad is vigilancia.Severidad.ALTA


def test_una_variacion_pequena_no_genera_ruido(puntuados):
    anterior = _instantanea(puntuados)
    apenas = [replace(p, caudal_m3_h=p.caudal_m3_h * 1.03) for p in puntuados]
    assert not [
        c for c in vigilancia.comparar(apenas, anterior) if c.tipo == "caudal"
    ]


# ==========================================================================
# Extraccion de permisos
# ==========================================================================

def _permiso(**kwargs):
    base = dict(
        razon_social="X", nit="", expediente="", autoridad="",
        caudal_autorizado_l_s=0.0, cuerpo_receptor="", vigencia_hasta="",
        parametros=[], confianza=0.9, observaciones="",
    )
    base.update(kwargs)
    return extraccion.PermisoExtraido(**base)


def _param(nombre, valor, unidad):
    return extraccion.ParametroExtraido(nombre=nombre, valor=valor, unidad=unidad)


def test_se_reconocen_los_nombres_administrativos_habituales():
    r = extraccion.traducir(_permiso(parametros=[
        _param("DQO (Demanda Quimica de Oxigeno)", 310, "mg/L"),
        _param("Solidos Suspendidos Totales", 45, "mg/L"),
        _param("Nitrógeno amoniacal", 3.1, "mg/L"),
    ]))
    assert r.calidad_parcial == {"dqo": 310.0, "sst": 45.0, "n_amoniacal": 3.1}


def test_se_convierten_las_unidades():
    r = extraccion.traducir(_permiso(parametros=[
        _param("Hierro total", 1500, "ug/L"),
        _param("Temperatura", 104, "F"),
    ]))
    assert r.calidad_parcial["hierro"] == pytest.approx(1.5)
    assert r.calidad_parcial["t_c"] == pytest.approx(40.0)


def test_los_parametros_no_modelados_se_apartan_sin_perderse():
    r = extraccion.traducir(_permiso(parametros=[
        _param("DBO5", 180, "mg/L"),
        _param("Grasas y aceites", 12, "mg/L"),
    ]))
    assert not r.calidad_parcial
    assert set(r.informativos) == {"dbo5", "grasas y aceites"}


def test_un_parametro_desconocido_se_reporta_en_vez_de_ignorarse():
    r = extraccion.traducir(_permiso(parametros=[
        _param("Indice de perturbacion cosmica", 7, "ud"),
    ]))
    assert r.no_reconocidos == ["Indice de perturbacion cosmica"]


def test_el_caudal_del_permiso_pasa_a_metros_cubicos_hora():
    r = extraccion.traducir(_permiso(caudal_autorizado_l_s=10.0))
    assert r.caudal_m3_h == pytest.approx(36.0)


def test_lo_extraido_pisa_la_estimacion_del_arquetipo():
    base = ciiu.ARQUETIPOS_POR_CLAVE["bebidas"].calidad
    r = extraccion.traducir(_permiso(parametros=[_param("DQO", 88, "mg/L")]))
    nueva, medidos = r.aplicar_a(base)
    assert nueva.dqo == 88.0
    assert medidos == frozenset({"dqo"})
    assert nueva.tds == base.tds       # lo no medido no se toca


def test_sin_el_paquete_la_extraccion_se_declara_no_disponible():
    """Una funcion opcional que falta no puede tumbar la prospeccion."""
    ok, motivo = extraccion.disponible()
    if not ok:
        assert motivo.strip()


# ==========================================================================
# API
# ==========================================================================

@pytest.fixture(scope="module")
def cliente():
    return TestClient(app)


@pytest.mark.parametrize("ruta", [
    "/api/scout/estado", "/api/scout/arquetipos", "/api/scout/barrido",
    "/api/scout/pipeline", "/api/scout/vigilancia",
])
def test_los_endpoints_responden(cliente, ruta):
    assert cliente.get(ruta).status_code == 200


def test_el_barrido_declara_el_origen_de_cada_fuente(cliente):
    d = cliente.get("/api/scout/barrido").json()
    assert d["fuentes"]
    for f in d["fuentes"]:
        assert f["origen"] in {"fixture", "cache", "red", "sin dato"}


def test_el_barrido_cuenta_como_se_consultaron_los_permisos(cliente):
    """El dashboard necesita decir de donde salio cada cosa, tambien VITAL."""
    d = cliente.get("/api/scout/barrido").json()
    assert d["permisos"]["origen"] in {"cache", "red", "sin dato"}
    assert d["permisos"]["cruzados"] <= d["permisos"]["total"]
    assert d["modo"] in {"offline", "cache", "vivo"}
    for f in d["fuentes"]:
        # La fecha del dato solo tiene sentido cuando sale de la cache.
        assert (f["origen"] == "cache") == bool(f["fecha_dato"]) or f["origen"] != "cache"


def test_el_modo_se_puede_elegir_por_peticion(cliente, monkeypatch):
    """Desde el dashboard se pide 'consulta ahora' sin reiniciar el servidor.

    En offline el resultado no puede depender de la red; se comprueba que el
    modo pedido queda registrado y que uno inventado se rechaza con 422.
    """
    monkeypatch.setenv("SIMBIA_SCOUT_MODO", "offline")
    d = cliente.get("/api/scout/barrido?refrescar=true&modo=offline").json()
    assert d["modo"] == "offline"
    assert d["modo_configurado"] == "offline"
    r = cliente.get("/api/scout/barrido?refrescar=true&modo=loquesea")
    assert r.status_code == 422
    assert "offline" in r.json()["detail"]


def test_cada_prospecto_expone_su_procedencia(cliente):
    d = cliente.get("/api/scout/barrido").json()
    for p in d["prospectos"]:
        assert p["metodo_calidad"] in {m.value for m in Metodo}
        assert p["referencias"], "un prospecto sin referencias no es auditable"
        assert 0.0 <= p["confianza"] <= 1.0


def test_el_optimizador_corre_con_el_catalogo_prospectado(cliente):
    d = cliente.post("/api/scout/optimizar", json={}).json()
    assert d["factible"] is True
    assert d["catalogo"]
    assert d["optimo"]["ahorro_pct_planta"] > 0


def test_un_umbral_inalcanzable_no_revienta_sino_que_lo_explica(cliente):
    d = cliente.post("/api/scout/optimizar", json={"umbral_confianza": 1.0}).json()
    assert d["factible"] is False
    assert "confianza" in d["motivo"]


def test_el_pipeline_separa_las_fichas_huerfanas(cliente, tmp_path, monkeypatch):
    _almacen_temporal(tmp_path, monkeypatch)
    almacen.actualizar_ficha("huerfana-1", estado=Estado.CONTACTADO, nombre="Zzz Inexistente")
    from simbia.api import scout as api_scout
    api_scout._invalidar()
    d = cliente.get("/api/scout/pipeline").json()
    assert d["fichas_abiertas"] == 0
    assert [h["clave"] for h in d["fichas_huerfanas"]] == ["huerfana-1"]
    # Reasignarla al primer prospecto del barrido la saca de huerfanas.
    b = cliente.get("/api/scout/barrido").json()
    if b["prospectos"]:
        destino = b["prospectos"][0]["clave"]
        r = cliente.post("/api/scout/ficha/reasignar",
                         json={"clave_origen": "huerfana-1", "clave_destino": destino})
        assert r.status_code == 200 and r.json()["estado"] == "contactado"
        d = cliente.get("/api/scout/pipeline").json()
        assert d["fichas_abiertas"] == 1 and not d["fichas_huerfanas"]
    assert cliente.post("/api/scout/ficha/reasignar",
                        json={"clave_origen": "x", "clave_destino": "y"}).status_code == 422


def test_una_etapa_inexistente_se_rechaza(cliente):
    r = cliente.post("/api/scout/ficha", json={
        "clave": "zzz", "estado": "inventada",
    })
    assert r.status_code == 422


def test_no_se_acepta_como_pdf_algo_que_no_lo_es(cliente):
    import base64
    r = cliente.post("/api/scout/extraer", json={
        "contenido_b64": base64.b64encode(b"esto no es un pdf").decode(),
    })
    # 503 si la IA no esta configurada, 422 si lo esta y detecta el formato.
    assert r.status_code in (422, 503)
