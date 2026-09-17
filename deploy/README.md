# Despliegue

SIMBIA corre en el VPS de SentraLabs (`193.122.159.98`, Ubuntu 22.04 arm64) y
se publica como **https://simbia.sentralabs.co** con
[SentraDNS](https://github.com/Manuuell/SentraDNS): el wildcard
`*.sentralabs.co` ya apunta al VPS, así que publicar un subdominio nuevo no
toca el DNS.

## Cómo está montado

| Pieza | Dónde |
|---|---|
| Código | `/var/www/simbia` (clon de este repo, propietario `ubuntu`) |
| Entorno | `/var/www/simbia/.venv`, Python 3.12 (el 3.10 del sistema no sirve para las versiones fijadas) |
| Servicio | `simbia.service` (systemd), uvicorn en `127.0.0.1:8123`, modo de fuentes `offline` |
| Vhost | `sentradns add simbia --tipo proxy --puerto 8123 --proyecto SIMBIA --max-body 40m --timeout 120s` |
| TLS | Let's Encrypt, renovado por certbot |
| Acceso | Usuario y contraseña en `/etc/simbia.env` (600 root); ver más abajo |

`--max-body 40m` porque los PDF de expedientes viajan en base64; `--timeout
120s` porque la frontera y las contingencias tardan varios segundos en ARM.

## Instalar desde cero

```bash
sudo install -d -o ubuntu -g ubuntu /var/www/simbia
git clone https://github.com/Manuuell/SIMBIA-RETO-CABOT.git /var/www/simbia
cd /var/www/simbia/backend
python3.12 -m venv .venv
.venv/bin/pip install --no-cache-dir -r backend/requirements.txt
(cd backend && ../.venv/bin/python -m simbia.ml.train)     # ~6 s
sudo install -m 644 deploy/simbia.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now simbia
curl -s http://127.0.0.1:8123/salud
sudo sentradns add simbia --tipo proxy --puerto 8123 --proyecto SIMBIA --max-body 40m --timeout 120s
sentradns check simbia
```

La caché de fuentes (`backend/simbia/scout/archivo/cache/`) no está en git.
Sin ella, la prospección arranca vacía hasta que alguien lance un barrido
**En vivo** desde el módulo *Datos externos*; para arrancar con datos, copiarla
desde una máquina que ya la tenga:

```bash
rsync -az backend/simbia/scout/archivo/cache ubuntu@VPS:/var/www/simbia/backend/simbia/scout/archivo/
```

## Acceso con usuario y contraseña

La aplicación pide identificarse si `SIMBIA_AUTH_HASH` está definida. La
contraseña **nunca se escribe en claro**: se guarda su hash scrypt, generado
leyendo la contraseña por stdin o pidiéndola de forma interactiva (sin eco, sin
historial). El secreto firma la cookie de sesión; cambiarlo cierra todas las
sesiones.

```bash
cd /var/www/simbia/backend
HASH=$(../.venv/bin/python -m simbia.auth hash)          # pide la contraseña dos veces
sudo install -m 600 -o root -g root /dev/null /etc/simbia.env
printf 'SIMBIA_AUTH_USUARIO=%s\nSIMBIA_AUTH_HASH=%s\nSIMBIA_AUTH_SECRETO=%s\n' \
  'correo@dominio' "$HASH" "$(openssl rand -hex 32)" | sudo tee /etc/simbia.env > /dev/null
sudo systemctl restart simbia
```

Para cambiar la contraseña, repetir lo mismo (solo cambia `SIMBIA_AUTH_HASH`).
Cinco intentos fallidos desde una IP la bloquean quince minutos; la sesión
dura doce horas.

## IA por API: extraccion, asistente y voz

Con `OPENAI_API_KEY` en `/etc/simbia.env` se activan la lectura de permisos en
PDF, el asistente (panel "Asistente" en la barra lateral) y la voz. La clave se
pide por teclado, sin eco:

```bash
read -rs -p 'OPENAI_API_KEY: ' K && echo && printf 'OPENAI_API_KEY=%s\n' "$K" | sudo tee -a /etc/simbia.env > /dev/null && unset K
sudo systemctl restart simbia
```

Modelos por defecto: `gpt-4.1-mini` (texto y PDF) y `gpt-4o-mini-tts` con la voz
`nova`; se cambian con `SIMBIA_IA_MODELO`, `SIMBIA_IA_MODELO_VOZ` y
`SIMBIA_IA_VOZ`. Cada pregunta al asistente envia el contexto de la aplicacion
(unas decenas de KB); cada documento se resume una sola vez y el resumen queda
junto al archivo (`*.resumen.json`).

Para rotar la clave: sustituir la linea en `/etc/simbia.env` y reiniciar.

## Documentos guardados desde el buscador

"Guardar en expediente" deja los archivos en
`backend/simbia/scout/archivo/expedientes/<radicado>/` (fuera de git). Cuentan
para el disco del VPS: una solicitud de licencia puede pesar decenas de MB.
`documentos.MAX_BYTES` (60 MB) es el tope por archivo.

## Actualizar

```bash
cd /var/www/simbia && git pull
.venv/bin/pip install --no-cache-dir -r backend/requirements.txt   # solo si cambió
sudo systemctl restart simbia
```

El frontend son ficheros estáticos servidos por la propia aplicación: un
`git pull` basta y no hay nada que compilar. Los modelos se reentrenan con
`python -m simbia.ml.train` solo si cambia `data/synth.py` o `ml/`.

## Comprobar

```bash
systemctl status simbia
sudo journalctl -u simbia -n 50
sentradns check simbia
```
