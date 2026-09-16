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

`--max-body 40m` porque los PDF de expedientes viajan en base64; `--timeout
120s` porque la frontera y las contingencias tardan varios segundos en ARM.

## Instalar desde cero

```bash
sudo install -d -o ubuntu -g ubuntu /var/www/simbia
git clone https://github.com/Manuuell/SIMBIA-RETO-CABOT.git /var/www/simbia
cd /var/www/simbia
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
