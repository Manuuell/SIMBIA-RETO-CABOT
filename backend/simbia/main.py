"""Punto de entrada de la aplicacion SIMBIA.

    uvicorn simbia.main:app --reload --port 8000
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import __version__
from .api.routes import router

WEB = Path(__file__).resolve().parents[2] / "frontend"

app = FastAPI(
    title="SIMBIA",
    description=(
        "Plataforma de simbiosis hidrica industrial asistida por IA. "
        "Reto Cabot: reducir >=10% el consumo de agua reutilizando aguas de "
        "rechazo de empresas vecinas en los sistemas de enfriamiento."
    ),
    version=__version__,
)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)
app.include_router(router)


@app.get("/salud")
def salud() -> dict[str, str]:
    return {"estado": "ok", "version": __version__}


# El dashboard se sirve en la raiz. Se monta al final para que /api y /salud,
# declarados antes, tengan prioridad sobre los ficheros estaticos.
if WEB.is_dir():
    app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
