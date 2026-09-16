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
from .api.scout import router as router_scout

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
app.include_router(router_scout)


@app.get("/salud")
def salud() -> dict[str, str]:
    return {"estado": "ok", "version": __version__}


@app.middleware("http")
async def revalidar_estaticos(request, call_next):
    """Obliga al navegador a revalidar los ficheros del dashboard.

    Sin esto, `StaticFiles` responde con ETag pero sin `Cache-Control`, y el
    navegador se queda con su copia sin preguntar: al editar el CSS o el HTML
    se sigue viendo la version anterior hasta forzar un recargado duro. Con
    `no-cache` el navegador pregunta siempre y el servidor contesta 304 si no
    ha cambiado nada, asi que no se pierde velocidad, solo se gana correccion.

    Es lo apropiado para una aplicacion que se sirve a si misma y se edita en
    caliente. En un despliegue con CDN se cambiaria por huellas en el nombre
    del fichero y cacheado largo.
    """
    respuesta = await call_next(request)
    if not request.url.path.startswith(("/api", "/salud", "/docs", "/openapi")):
        respuesta.headers["Cache-Control"] = "no-cache"
    return respuesta


# El dashboard se sirve en la raiz. Se monta al final para que /api y /salud,
# declarados antes, tengan prioridad sobre los ficheros estaticos.
if WEB.is_dir():
    app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
