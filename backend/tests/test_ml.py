"""Los modelos deben batir a su referencia ingenua y no filtrar el futuro."""

import numpy as np
import pytest

from simbia.data.synth import ConfigSintetica, generar
from simbia.ml.models import (
    DetectorFugas, ModeloDemanda, RiesgoEnsuciamiento, rasgos_demanda,
)


@pytest.fixture(scope="module")
def df():
    return generar(cfg=ConfigSintetica(horas=24 * 30 * 12))


def test_el_historico_es_fisicamente_coherente(df):
    assert (df["reposicion_m3_h"] > 0).all()
    assert (df["ciclos"] > 1).all()
    # Reposicion sin fuga = evaporacion + purga + arrastre (con ruido de medida).
    esperado = df["_evaporacion_real_m3_h"] + df["purga_m3_h"]
    assert (df["_reposicion_sin_fuga_m3_h"] / esperado).between(0.9, 1.1).mean() > 0.9
    assert 0.0 < df["fuga_activa"].mean() < 0.5


def test_los_rasgos_no_contienen_el_objetivo(df):
    x, y = rasgos_demanda(df)
    assert len(x) == len(y)
    for col in x.columns:
        # Ninguna columna puede ser el propio objetivo desplazado.
        assert not np.allclose(x[col].to_numpy(), y.to_numpy(), rtol=1e-6)


def test_demanda_bate_a_la_persistencia(df):
    m = ModeloDemanda().entrenar(df)
    assert m.mae < m.mae_persistencia
    assert m.mae < m.mae_media_movil
    assert m.mape < 0.15


def test_el_residual_fisico_sube_con_la_fuga(df):
    r = DetectorFugas.residual_fisico(df)
    assert r[df["fuga_activa"] == 1].mean() > r[df["fuga_activa"] == 0].mean()


def test_detector_de_fugas_util(df):
    m = DetectorFugas().entrenar(df)
    prevalencia = df["fuga_activa"].mean()
    assert m.auc_pr > prevalencia * 1.5      # mejor que azar por buen margen
    assert m.precision > 0.5 and m.recall > 0.4


def test_el_ensuciamiento_se_acumula(df):
    """El deposito es un integrador: crece mas rapido con agua incrustante.

    Se excluyen las horas de limpieza quimica: durante una limpieza el
    deposito cae, y las limpiezas ocurren precisamente tras los periodos
    incrustantes, asi que incluirlas invierte la comparacion.
    """
    crecimiento = df["_deposito"].diff()
    limpiando = crecimiento < -1.0
    assert limpiando.sum() > 0, "el historico debe incluir limpiezas quimicas"

    normal = crecimiento[~limpiando]
    lsi = df.loc[normal.index, "lsi_circulante"]
    incrustante = lsi > lsi.quantile(0.8)
    assert normal[incrustante].mean() > normal[~incrustante].mean() * 1.2


def test_la_senal_de_acercamiento_no_es_una_lectura_directa(df):
    """Debe estar confundida por carga y clima; si no, el problema es trivial."""
    r = df["aproximacion_c"].corr(df["_deposito"])
    assert 0.6 < r < 0.95


def test_riesgo_de_ensuciamiento_discrimina(df):
    m = RiesgoEnsuciamiento().entrenar(df)
    assert m.auc_roc > 0.80
    assert m.lift > 2.0
    assert m.recall >= RiesgoEnsuciamiento.RECALL_OBJETIVO - 0.05


def test_reproducibilidad(df):
    a = ModeloDemanda().entrenar(df)
    b = ModeloDemanda().entrenar(df)
    assert a.mae == pytest.approx(b.mae)
