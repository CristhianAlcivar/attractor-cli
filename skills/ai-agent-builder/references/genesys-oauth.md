# Conexión OAuth a Genesys Cloud CX

Patrón para que un agente de servicio se autentique contra una organización de
Genesys Cloud y pueda invocar Data Actions, consultar Knowledge Bases o usar la
API de la plataforma (`/api/v2/...`).

Fuentes: documentación oficial de Genesys sobre el grant de Client Credentials
y la creación de OAuth clients. Contenido reformulado para cumplir con
restricciones de licencia.
- https://developer.genesys.cloud/authorization/platform-auth/use-client-credentials
- https://developer.genesys.cloud/authorization/platform-auth/guides/oauth-client-credentials-guide

## 1. Elegir el grant

- **Client Credentials** — para un servicio/backend sin UI que actúa como la
  integración (no en nombre de un usuario). Es el caso por defecto de un agente.
  No puede usar endpoints de contexto de usuario como `/api/v2/users/me`.
- **Authorization Code** — solo si el agente debe actuar con los permisos del
  usuario final que inicia sesión (login interactivo + redirect URI).

## 2. Crear el OAuth client en la org

En Genesys: `Admin > Integrations > OAuth` → nuevo client con grant
**Client Credentials**. Genesys genera `Client ID` y `Client Secret` (el secret
se ve una sola vez). Asigna los roles y divisiones mínimos necesarios. El client
solo funciona para la org donde se creó.

## 3. Variables de entorno sugeridas

```
GENESYS_REGION=mypurecloud.com        # o usw2.pure.cloud, mec1.pure.cloud, etc.
GENESYS_CLIENT_ID=xxxxxxxx
GENESYS_CLIENT_SECRET=xxxxxxxx
```

Nunca pongas el client_id/secret en el código ni en el system prompt.

## 4. Endpoints

- Token:  `POST https://login.{GENESYS_REGION}/oauth/token`
- API:    `https://api.{GENESYS_REGION}/api/v2/...`

## 5. Flujo del token (Client Credentials)

1. `POST https://login.{REGION}/oauth/token`
   - Header: `Authorization: Basic base64(client_id:client_secret)`
   - Header: `Content-Type: application/x-www-form-urlencoded`
   - Body: `grant_type=client_credentials`
2. Respuesta: `{ "access_token": "...", "token_type": "bearer", "expires_in": 86400 }`
3. Usa `Authorization: Bearer {access_token}` en cada llamada a la API.
4. Cachea el token en memoria y refréscalo antes de `expires_in`
   (margen de seguridad, p. ej. refrescar al 90% del tiempo de vida).

## 6. Esqueleto de cliente (referencia, Python)

Patrón mínimo con cache y refresh. No incluye secretos.

```python
import base64, os, time
import httpx

class GenesysAuth:
    def __init__(self):
        self.region = os.environ["GENESYS_REGION"]
        self.client_id = os.environ["GENESYS_CLIENT_ID"]
        self.client_secret = os.environ["GENESYS_CLIENT_SECRET"]
        self._token: str | None = None
        self._expiry: float = 0.0

    @property
    def login_base(self) -> str:
        return f"https://login.{self.region}"

    @property
    def api_base(self) -> str:
        return f"https://api.{self.region}"

    def token(self) -> str:
        # Refresca al acercarse a la expiración (margen del 10%).
        if self._token and time.time() < self._expiry:
            return self._token
        creds = f"{self.client_id}:{self.client_secret}".encode()
        basic = base64.b64encode(creds).decode()
        resp = httpx.post(
            f"{self.login_base}/oauth/token",
            headers={
                "Authorization": f"Basic {basic}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data={"grant_type": "client_credentials"},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        self._token = data["access_token"]
        self._expiry = time.time() + data.get("expires_in", 86400) * 0.9
        return self._token

    def get(self, path: str, **kwargs) -> httpx.Response:
        return httpx.get(
            f"{self.api_base}{path}",
            headers={"Authorization": f"Bearer {self.token()}"},
            timeout=30,
            **kwargs,
        )
```

## 7. Seguridad

- Secretos solo en `.env` / gestor de secretos; refiérete a ellos por nombre.
- Mínimo privilegio: asigna al OAuth client solo los roles y divisiones que use.
- Maneja `401`/`403` refrescando el token una vez; si persiste, reporta sin
  reintentar en bucle.
- Respeta los límites de rate de la API y aplica backoff ante `429`.
