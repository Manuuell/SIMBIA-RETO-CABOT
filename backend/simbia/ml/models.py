"""Modelos de IA de SIMBIA.

Tres modelos, cada uno con un uso operativo concreto:

  1. ModeloDemanda      - cuanta reposicion hara falta dentro de 24 h, para
                          contratar por adelantado el caudal de rechazo a los
                          vecinos en lugar de improvisar con agua cruda.
  2. DetectorFugas      - hibrido fisica + ML. Compara el caudal de reposicion
                          medido contra el que EXIGE el balance de masa y
                          aprende a distinguir una fuga del ruido de medida.
  3. RiesgoEnsuciamiento - probabilidad de entrar en condicion incrustante o
                          de biofouling en los proximos 7 dias, para bajar
                          ciclos o cambiar la mezcla antes, no despues.

Todos se entrenan y evaluan con particion TEMPORAL (nunca aleatoria): usar
validacion cruzada aleatoria en una serie de tiempo infla las metricas.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd
from sklearn.ensemble import (
    HistGradientBoostingClassifier, HistGradientBoostingRegressor,
)
from sklearn.metrics import (
    average_precision_score, mean_absolute_error, precision_recall_fscore_support,
    roc_auc_score,
)

from ..domain import cooling

ARTEFACTOS = Path(__file__).parent / "artefactos"
HORIZONTE_H = 24
FRACCION_ENTRENAMIENTO = 0.7


def _particion_temporal(n: int, frac: float = FRACCION_ENTRENAMIENTO) -> tuple[slice, slice]:
    corte = int(n * frac)
    return slice(0, corte), slice(corte, n)


# --------------------------------------------------------------------------
# 1. Demanda de reposicion
# --------------------------------------------------------------------------

RASGOS_DEMANDA = [
    "t_amb_c", "humedad_rel", "carga_produccion",
    "caudal_circulacion_m3_h", "delta_t_c", "ciclos",
    "reposicion_m3_h", "reposicion_media_24h", "reposicion_media_168h",
    "t_amb_pronostico", "humedad_pronostico", "carga_programada",
    "hora", "dia_semana",
]


def rasgos_demanda(
    df: pd.DataFrame, horizonte: int = HORIZONTE_H, rng_semilla: int = 11
) -> tuple[pd.DataFrame, pd.Series]:
    """Construye la matriz de rasgos y el objetivo (reposicion a +horizonte).

    El pronostico meteorologico y el plan de produccion son entradas legitimas
    (se conocen por adelantado). Sobre el historico sintetico se emulan con el
    valor futuro real degradado con ruido, que es lo que hace un pronostico.
    """
    rng = np.random.default_rng(rng_semilla)
    x = pd.DataFrame(index=df.index)
    x["t_amb_c"] = df["t_amb_c"]
    x["humedad_rel"] = df["humedad_rel"]
    x["carga_produccion"] = df["carga_produccion"]
    x["caudal_circulacion_m3_h"] = df["caudal_circulacion_m3_h"]
    x["delta_t_c"] = df["delta_t_c"]
    x["ciclos"] = df["ciclos"]
    x["reposicion_m3_h"] = df["reposicion_m3_h"]
    x["reposicion_media_24h"] = df["reposicion_m3_h"].rolling(24, min_periods=1).mean()
    x["reposicion_media_168h"] = df["reposicion_m3_h"].rolling(168, min_periods=1).mean()

    n = len(df)
    x["t_amb_pronostico"] = (
        df["t_amb_c"].shift(-horizonte) + rng.normal(0, 0.8, n)
    )
    x["humedad_pronostico"] = np.clip(
        df["humedad_rel"].shift(-horizonte) + rng.normal(0, 0.04, n), 0.2, 1.0
    )
    x["carga_programada"] = np.clip(
        df["carga_produccion"].shift(-horizonte) + rng.normal(0, 0.02, n), 0.0, 1.1
    )
    x["hora"] = df.index.hour
    x["dia_semana"] = df.index.dayofweek

    y = df["reposicion_m3_h"].shift(-horizonte)
    valido = y.notna() & x["t_amb_pronostico"].notna()
    return x.loc[valido, RASGOS_DEMANDA], y.loc[valido]


@dataclass
class ResultadoDemanda:
    mae: float
    mape: float
    mae_persistencia: float
    mae_media_movil: float
    mejora_vs_persistencia: float
    importancias: dict[str, float] = field(default_factory=dict)


class ModeloDemanda:
    def __init__(self) -> None:
        self.modelo = HistGradientBoostingRegressor(
            max_iter=400, learning_rate=0.06, max_depth=6,
            l2_regularization=1.0, random_state=7,
        )
        self.metricas: ResultadoDemanda | None = None

    def entrenar(self, df: pd.DataFrame, horizonte: int = HORIZONTE_H) -> ResultadoDemanda:
        x, y = rasgos_demanda(df, horizonte)
        tr, te = _particion_temporal(len(x))
        self.modelo.fit(x.iloc[tr], y.iloc[tr])
        pred = self.modelo.predict(x.iloc[te])
        real = y.iloc[te].to_numpy()

        mae = float(mean_absolute_error(real, pred))
        mape = float(np.mean(np.abs((real - pred) / real)))
        # Referencias honestas. A 24 h de horizonte la ingenua estacional
        # coincide con la persistencia, asi que se usa la media movil de 24 h,
        # que es una referencia mas dura.
        persistencia = x.iloc[te]["reposicion_m3_h"].to_numpy()
        media_movil = x.iloc[te]["reposicion_media_24h"].to_numpy()
        mae_p = float(mean_absolute_error(real, persistencia))
        mae_e = float(mean_absolute_error(real, media_movil))

        from sklearn.inspection import permutation_importance
        imp = permutation_importance(
            self.modelo, x.iloc[te], y.iloc[te], n_repeats=3, random_state=3,
            scoring="neg_mean_absolute_error",
        )
        importancias = dict(sorted(
            zip(RASGOS_DEMANDA, (float(v) for v in imp.importances_mean)),
            key=lambda kv: -kv[1],
        ))
        self.metricas = ResultadoDemanda(
            mae=mae, mape=mape, mae_persistencia=mae_p, mae_media_movil=mae_e,
            mejora_vs_persistencia=1.0 - mae / mae_p if mae_p else 0.0,
            importancias=importancias,
        )
        return self.metricas

    def predecir(self, x: pd.DataFrame) -> np.ndarray:
        return self.modelo.predict(x[RASGOS_DEMANDA])


# --------------------------------------------------------------------------
# 2. Deteccion de fugas (hibrido fisica + ML)
# --------------------------------------------------------------------------

@dataclass
class ResultadoFugas:
    precision: float
    recall: float
    f1: float
    auc_pr: float
    umbral: float
    m3_recuperables_anio: float


class DetectorFugas:
    """Residual del balance de masa + clasificador sobre su dinamica.

    La reposicion que EXIGE la fisica es E + P + A. Si el caudalimetro mide
    sistematicamente mas que eso, hay una perdida no contabilizada. El residual
    normalizado es la senal; el modelo aprende a separar fuga de ruido y de
    error de estimacion de la evaporacion.
    """

    RASGOS = [
        "residual", "residual_media_6h", "residual_media_24h",
        "residual_std_24h", "tendencia_24h", "carga_produccion", "delta_t_c",
    ]

    def __init__(self) -> None:
        self.modelo = HistGradientBoostingClassifier(
            max_iter=300, learning_rate=0.08, max_depth=5, random_state=5,
        )
        self.umbral = 0.5
        self.metricas: ResultadoFugas | None = None

    @staticmethod
    def residual_fisico(df: pd.DataFrame, factor_evaporacion: float = 0.80) -> pd.Series:
        """(medido - exigido por balance) / exigido.

        La evaporacion no se mide: se estima con la carga termica. El factor
        evaporativo real depende del clima, asi que el residual arrastra un
        sesgo lento; por eso el modelo mira la DINAMICA del residual y no su
        valor absoluto.
        """
        evap = (
            df["caudal_circulacion_m3_h"] * df["delta_t_c"]
            * cooling.CP_KJ_KG_K / cooling.LAMBDA_KJ_KG * factor_evaporacion
        )
        arrastre = df["caudal_circulacion_m3_h"] * 5.0e-5
        exigido = evap + df["purga_m3_h"] + arrastre
        return (df["reposicion_m3_h"] - exigido) / exigido

    def rasgos(self, df: pd.DataFrame) -> pd.DataFrame:
        r = self.residual_fisico(df)
        x = pd.DataFrame(index=df.index)
        x["residual"] = r
        x["residual_media_6h"] = r.rolling(6, min_periods=1).mean()
        x["residual_media_24h"] = r.rolling(24, min_periods=1).mean()
        x["residual_std_24h"] = r.rolling(24, min_periods=2).std().fillna(0.0)
        x["tendencia_24h"] = (
            r.rolling(6, min_periods=1).mean()
            - r.rolling(72, min_periods=1).mean()
        )
        x["carga_produccion"] = df["carga_produccion"]
        x["delta_t_c"] = df["delta_t_c"]
        return x[self.RASGOS]

    def entrenar(self, df: pd.DataFrame) -> ResultadoFugas:
        x = self.rasgos(df)
        y = df["fuga_activa"].to_numpy()
        tr, te = _particion_temporal(len(x))
        self.modelo.fit(x.iloc[tr], y[tr])
        prob = self.modelo.predict_proba(x.iloc[te])[:, 1]

        # Umbral que maximiza F1 sobre la particion de validacion.
        mejor = (0.5, 0.0)
        for u in np.linspace(0.05, 0.95, 91):
            p, r_, f1, _ = precision_recall_fscore_support(
                y[te], prob >= u, average="binary", zero_division=0
            )
            if f1 > mejor[1]:
                mejor = (float(u), float(f1))
        self.umbral = mejor[0]
        p, r_, f1, _ = precision_recall_fscore_support(
            y[te], prob >= self.umbral, average="binary", zero_division=0
        )
        # Agua recuperable: la fraccion de fuga efectivamente detectada.
        detectadas = (prob >= self.umbral) & (y[te] == 1)
        exceso = (
            df["_fuga_fraccion"].to_numpy()[te][detectadas]
            * df["_reposicion_sin_fuga_m3_h"].to_numpy()[te][detectadas]
        ).sum()
        horas_val = max(len(y[te]), 1)
        m3_anio = float(exceso / horas_val * 8760.0)

        self.metricas = ResultadoFugas(
            precision=float(p), recall=float(r_), f1=float(f1),
            auc_pr=float(average_precision_score(y[te], prob)),
            umbral=self.umbral, m3_recuperables_anio=m3_anio,
        )
        return self.metricas

    def predecir(self, df: pd.DataFrame) -> np.ndarray:
        return self.modelo.predict_proba(self.rasgos(df))[:, 1]


# --------------------------------------------------------------------------
# 3. Riesgo de ensuciamiento a 7 dias
# --------------------------------------------------------------------------

@dataclass
class ResultadoRiesgo:
    auc_roc: float
    auc_pr: float
    precision: float
    recall: float
    prevalencia: float
    umbral: float
    #: Cuantas veces mas probable es el evento cuando el modelo avisa.
    lift: float


class RiesgoEnsuciamiento:
    #: Un aviso tardio cuesta una limpieza quimica del circuito; un falso
    #: positivo solo cuesta bajar ciclos unos dias. El punto de operacion se
    #: elige, por tanto, con recall alto y no maximizando F1.
    RECALL_OBJETIVO = 0.75

    RASGOS = [
        "lsi_circulante", "ph_circulante", "conductividad_us_cm",
        "t_circulante_c", "ciclos", "purga_m3_h", "carga_produccion",
        "t_amb_c", "humedad_rel", "aproximacion_c",
        "lsi_media_72h", "ciclos_media_72h", "aproximacion_media_72h",
        "tendencia_aproximacion",
    ]

    def __init__(self) -> None:
        self.modelo = HistGradientBoostingClassifier(
            max_iter=350, learning_rate=0.06, max_depth=5, random_state=13,
        )
        self.umbral = 0.5
        self.metricas: ResultadoRiesgo | None = None

    def rasgos(self, df: pd.DataFrame) -> pd.DataFrame:
        x = df[[
            "lsi_circulante", "ph_circulante", "conductividad_us_cm",
            "t_circulante_c", "ciclos", "purga_m3_h", "carga_produccion",
            "t_amb_c", "humedad_rel", "aproximacion_c",
        ]].copy()
        x["lsi_media_72h"] = df["lsi_circulante"].rolling(72, min_periods=1).mean()
        x["ciclos_media_72h"] = df["ciclos"].rolling(72, min_periods=1).mean()
        x["aproximacion_media_72h"] = (
            df["aproximacion_c"].rolling(72, min_periods=1).mean()
        )
        # La tendencia del acercamiento delata si el deposito esta creciendo.
        x["tendencia_aproximacion"] = (
            df["aproximacion_c"].rolling(24, min_periods=1).mean()
            - df["aproximacion_c"].rolling(240, min_periods=1).mean()
        )
        return x[self.RASGOS]

    def entrenar(self, df: pd.DataFrame) -> ResultadoRiesgo:
        x = self.rasgos(df)
        y = df["riesgo_fouling_7d"].to_numpy()
        tr, te = _particion_temporal(len(x))
        self.modelo.fit(x.iloc[tr], y[tr])
        prob = self.modelo.predict_proba(x.iloc[te])[:, 1]

        # Umbral mas exigente que alcance el recall objetivo.
        self.umbral = 0.5
        for u in np.linspace(0.95, 0.02, 94):
            _p, r_u, _f, _ = precision_recall_fscore_support(
                y[te], prob >= u, average="binary", zero_division=0
            )
            if r_u >= self.RECALL_OBJETIVO:
                self.umbral = float(u)
                break

        p, r_, _f1, _ = precision_recall_fscore_support(
            y[te], prob >= self.umbral, average="binary", zero_division=0
        )
        prevalencia = float(y[te].mean())
        self.metricas = ResultadoRiesgo(
            auc_roc=float(roc_auc_score(y[te], prob)),
            auc_pr=float(average_precision_score(y[te], prob)),
            precision=float(p), recall=float(r_),
            prevalencia=prevalencia, umbral=self.umbral,
            lift=float(p / prevalencia) if prevalencia else 0.0,
        )
        return self.metricas

    def predecir(self, df: pd.DataFrame) -> np.ndarray:
        return self.modelo.predict_proba(self.rasgos(df))[:, 1]


# --------------------------------------------------------------------------
# Persistencia
# --------------------------------------------------------------------------

def guardar(modelos: dict[str, object], destino: Path = ARTEFACTOS) -> Path:
    import joblib
    destino.mkdir(parents=True, exist_ok=True)
    reporte: dict[str, object] = {}
    for nombre, m in modelos.items():
        joblib.dump(m, destino / f"{nombre}.joblib")
        met = getattr(m, "metricas", None)
        if met is not None:
            reporte[nombre] = {
                k: v for k, v in vars(met).items() if not k.startswith("_")
            }
    (destino / "metricas.json").write_text(
        json.dumps(reporte, indent=2, ensure_ascii=False, default=float)
    )
    return destino


def cargar(nombre: str, origen: Path = ARTEFACTOS):
    import joblib
    ruta = origen / f"{nombre}.joblib"
    if not ruta.exists():
        return None
    return joblib.load(ruta)
