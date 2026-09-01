"""Entrena los tres modelos sobre el historico y guarda artefactos + metricas.

    python -m simbia.ml.train
"""

from __future__ import annotations

import sys

from ..data.synth import generar
from .models import DetectorFugas, ModeloDemanda, RiesgoEnsuciamiento, guardar


def main() -> int:
    print("Generando historico sintetico (18 meses horarios)...")
    df = generar()
    print(f"  {len(df):,} observaciones\n")

    print("1/3 Demanda de reposicion a 24 h")
    demanda = ModeloDemanda()
    md = demanda.entrenar(df)
    print(f"     MAE {md.mae:.3f} m3/h  |  MAPE {md.mape:.2%}")
    print(f"     referencias: persistencia MAE {md.mae_persistencia:.3f} | "
          f"media movil 24 h MAE {md.mae_media_movil:.3f}")
    print(f"     mejora sobre persistencia: {md.mejora_vs_persistencia:.1%}")
    top = list(md.importancias.items())[:5]
    print("     rasgos mas influyentes: "
          + ", ".join(f"{k} ({v:.3f})" for k, v in top))

    print("\n2/3 Deteccion de fugas (residual fisico + ML)")
    fugas = DetectorFugas()
    mf = fugas.entrenar(df)
    print(f"     precision {mf.precision:.3f}  recall {mf.recall:.3f}  "
          f"F1 {mf.f1:.3f}  AUC-PR {mf.auc_pr:.3f}  (umbral {mf.umbral:.2f})")
    print(f"     agua recuperable por deteccion temprana: "
          f"{mf.m3_recuperables_anio:,.0f} m3/anio")

    print("\n3/3 Riesgo de ensuciamiento a 7 dias")
    riesgo = RiesgoEnsuciamiento()
    mr = riesgo.entrenar(df)
    print(f"     AUC-ROC {mr.auc_roc:.3f}  AUC-PR {mr.auc_pr:.3f} "
          f"(prevalencia {mr.prevalencia:.2%})")
    print(f"     punto de operacion (umbral {mr.umbral:.2f}): "
          f"precision {mr.precision:.3f}  recall {mr.recall:.3f}  "
          f"lift x{mr.lift:.2f}")

    destino = guardar({
        "demanda": demanda, "fugas": fugas, "riesgo": riesgo,
    })
    print(f"\nArtefactos guardados en {destino}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
