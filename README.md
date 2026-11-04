# Vitalis

Aplicación hospitalaria de chat multiagente, ejecutada en Node.js 24 LTS. El
servidor Express entrega la interfaz y protege las operaciones de Foundry y
Azure SQL con Microsoft Entra ID y los roles vigentes de cada empleado.

## Desarrollo local

Requisitos: Node.js 24 LTS y npm.

1. Copia `.env.example` a `.env` y completa el endpoint de Foundry, nombres de
   agentes y la cadena de conexión SQL. No agregues credenciales al repositorio.
2. Genera un valor aleatorio para `SESSION_SECRET`:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

3. Registra una aplicación de Microsoft Entra para el inicio de sesión local.
   Configura la URI de redirección `http://localhost:8000/auth/callback` como
   plataforma web y asigna `MSAL_CLIENT_ID` y `MSAL_CLIENT_SECRET` en `.env`.
4. Inicia sesión con `az login` para que `DefaultAzureCredential` acceda a
   Foundry; la identidad debe tener acceso al proyecto.
5. Instala y ejecuta:

   ```powershell
   npm ci
   npm test
   npm start
   ```

Abre `http://localhost:8000`. Los mensajes del chat se mantienen en memoria del
navegador; no se guardan en almacenamiento local.

## Azure App Service

- Usa Linux y configura el stack integrado con `NODE|24-lts`. El proceso escucha
  en el puerto `PORT` (8000 por omisión).
- Configura `SCM_DO_BUILD_DURING_DEPLOYMENT=true` para restaurar dependencias y
  compilar TypeScript durante el despliegue. El comando de inicio es `npm start`.
- Conserva las variables `PROJECT_ENDPOINT`, los nombres `*_AGENT_NAME` y
  `AZURE_SQL_CONNECTION_STRING` del recurso existente. Añade `SESSION_SECRET`
  como secreto de App Service o Key Vault; nunca lo guardes en el repositorio.
- Si se usa Application Insights, conserva `APPLICATIONINSIGHTS_CONNECTION_STRING`.
  La instrumentación de Foundry no registra contenido de mensajes ni argumentos
  de herramientas.
- Habilita App Service Authentication con Microsoft Entra y exige autenticación.
  La aplicación confía en `X-MS-CLIENT-PRINCIPAL` únicamente dentro de App
  Service, después de que Easy Auth valide al usuario. Excluye `/healthz` de
  la autenticación para permitir las comprobaciones de salud. Configura el tenant
  permitido en `VITALIS_ENTRA_TENANT_ID`.
- Habilita una identidad administrada para App Service y concédele el rol mínimo
  necesario para invocar los agentes del proyecto de Foundry. La conexión SQL
  sigue usando la cadena de conexión configurada.
- Verifica `https://<app-service>/healthz` después del despliegue.

El App Service actual no tiene Easy Auth habilitado ni identidad administrada
asignada. Antes de recrearlo hay que configurar esos accesos y la autenticación
de Microsoft Entra; sin ellos, el servicio Node iniciará pero no podrá autenticar
usuarios ni obtener credenciales para Foundry.

## Actualización de prompts

`npm run update-prompts` publica una nueva versión de cada agente de tipo prompt
con los protocolos locales de `Protocolos/`. Requiere las credenciales de
`DefaultAzureCredential` y los nombres de agentes configurados.

## Contenedor

```powershell
docker build -t vitalis .
docker run --env-file .env -p 8000:8000 vitalis
```
