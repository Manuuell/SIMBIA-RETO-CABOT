"""Balance de la torre: la relacion M = E*N/(N-1) manda sobre todo el reto."""

import pytest

from simbia.config import Escenario
from simbia.domain import cooling
from simbia.domain.streams import AGUA_CRUDA
from simbia.domain.water_chem import Calidad


@pytest.fixture
def esc():
    return Escenario()


def test_reposicion_decrece_con_los_ciclos(esc):
    reposiciones = [cooling.balance(esc.torre, n).reposicion_m3_h
                    for n in (2, 3, 4, 6, 9)]
    assert reposiciones == sorted(reposiciones, reverse=True)


def test_reposicion_tiende_a_la_evaporacion(esc):
    """Con ciclos infinitos la purga desaparece: solo queda la evaporacion."""
    b = cooling.balance(esc.torre, 500.0)
    assert b.reposicion_m3_h == pytest.approx(
        cooling.evaporacion_m3_h(esc.torre), rel=0.01
    )


def test_balance_cierra(esc):
    for n in (2.5, 4.0, 7.0):
        b = cooling.balance(esc.torre, n)
        assert b.reposicion_m3_h == pytest.approx(
            b.evaporacion_m3_h + b.purga_m3_h + b.arrastre_m3_h
        )
        # Definicion de ciclos: N = M / (P + A)
        assert b.reposicion_m3_h / (b.purga_m3_h + b.arrastre_m3_h) == pytest.approx(n, rel=1e-6)


def test_ciclos_no_validos(esc):
    with pytest.raises(ValueError):
        cooling.balance(esc.torre, 1.0)


def test_reposicion_caliente_aumenta_la_evaporacion(esc):
    frio = cooling.balance(esc.torre, 6.0, t_reposicion_c=28.0)
    caliente = cooling.balance(esc.torre, 6.0, t_reposicion_c=55.0)
    assert caliente.reposicion_m3_h > frio.reposicion_m3_h
    assert caliente.evaporacion_m3_h > frio.evaporacion_m3_h


def test_reposicion_mas_fria_que_la_balsa_no_da_credito(esc):
    """No se modela recuperacion de frio: por debajo de la balsa, sin efecto."""
    a = cooling.balance(esc.torre, 5.0, t_reposicion_c=20.0)
    b = cooling.balance(esc.torre, 5.0, t_reposicion_c=cooling.T_BASIN_C)
    assert a.reposicion_m3_h == pytest.approx(b.reposicion_m3_h)


def test_agua_peor_admite_menos_ciclos(esc):
    salobre = Calidad(
        ph=7.6, t_c=30, tds=3200, dureza_ca=480, alcalinidad=320,
        cloruros=850, sulfatos=720, silice=75,
    )
    n_cruda, _ = cooling.ciclos_maximos(
        AGUA_CRUDA, esc.torre, esc.limites, esc.lsi_max_efectivo
    )
    n_salobre, limitante = cooling.ciclos_maximos(
        salobre, esc.torre, esc.limites, esc.lsi_max_efectivo
    )
    assert n_salobre < n_cruda
    assert limitante is not None


def test_el_agua_cruda_esta_limitada_por_incrustacion(esc):
    """Con agua blanda y alcalina, el techo lo pone el LSI, no la salinidad."""
    _, limitante = cooling.ciclos_maximos(
        AGUA_CRUDA, esc.torre, esc.limites, esc.lsi_max_efectivo
    )
    assert limitante == "lsi"


def test_violaciones_detecta_cada_limite(esc):
    mala = Calidad(tds=9999, cloruros=9999, sst=999, dqo=999, silice=999)
    fuera = cooling.violaciones(mala, esc.limites, esc.lsi_max_efectivo)
    for esperado in ("tds", "cloruros", "sst", "dqo", "silice", "conductividad"):
        assert esperado in fuera
