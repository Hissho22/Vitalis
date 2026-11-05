# Instrucciones del Proyecto: Vitalis - Gestión Hospitalaria Inteligente

## 1. Qué es este proyecto
**Vitalis** es una plataforma web hospitalaria integral. El frontend (HTML5, CSS3 y JavaScript vanilla, sin frameworks ni CDNs) se comunica con un backend en Node.js 24 LTS (Express 5). El backend coordina la persistencia en **Azure SQL Database** y la lógica conversacional con un ecosistema de agentes en **Microsoft Azure AI Foundry**. La solución completa se despliega en **Azure App Service (Linux, Node 24 LTS)**.

---

## 2. Entorno de Desarrollo y Ejecución
- **Sistema Operativo:** Windows 11 con PowerShell.
- **Runtime:** Node.js 24 LTS y `npm`.
- **Formato:** Backend en TypeScript compilado a ES Modules (NodeNext); frontend en HTML, CSS y JavaScript vanilla, sin empaquetadores (Vite, Webpack).
- **Manejo de Entorno Local:** `dotenv/config` carga `.env` al iniciar la aplicación. Ejecuta `npm start` después de `npm ci` y `npm run build`.
- **Puerto:** `process.env.PORT` o `8000` por defecto.

---

## 3. Stack Tecnológico y Dependencias Autorizadas
- **Servidor Web:** `express` (v5.x).
- **Conectividad Azure SQL:** `mssql` (cliente oficial para SQL Server / Azure SQL).
- **SDK Azure AI Foundry:** `@azure/ai-projects` (v2.x, API Foundry Projects) y `@azure/identity` (`DefaultAzureCredential`).
- **Prohibiciones:** Prohibido reintroducir Python, Streamlit, `@azure/ai-agents` (API 1.x obsoleta) o frameworks de frontend.

---

## 4. Esquema de Base de Datos (Azure SQL)
El backend opera sobre 6 tablas físicas normalizadas y 1 vista de lectura consolidada:

1. **`admision`**: `nss` (PK), `nombre`, `telefono`, `contacto_emergencia`, `parentesco`, `telefono_emergencia`.
2. **`historicos`**: `nss` (PK/FK), `fecha_nacimiento`, `sexo`, `tipo_sangre`, `alergias`, `enfermedades_cronicas`, `cirugias_previas`, `antecedentes_familiares`, `habitos_toxicologias`, `discapacidades_dispositivos`.
3. **`seguros`**: `id_seguro` (PK), `nss` (FK), `aseguradora`, `estatus` ('Activa', 'Vencida', 'Suspendida').
4. **`atencion`**: `id_atencion` (PK, IDENTITY), `nss` (FK), `fecha_hora`, `motivo_consulta`, `signos_vitales`, `notas_medicas`, `diagnostico`.
5. **`farmacia`**: `id_receta` (PK, IDENTITY), `id_atencion` (FK), `medicamento`, `dosis_y_tiempo`, `cantidad` (entero positivo de unidades de inventario prescritas, nullable solo para recetas históricas), `estatus_farmacia` ('Pendiente', 'Entregado'). La migración `scripts/migrations/20261105_agregar_cantidad_receta.sql` agrega la columna y su restricción.
6. **`empleados`**: `id_empleado` (PK), `nombre`, `correo`, `rol` ('Admin', 'Admision', 'Medico', 'Farmacia', 'Seguros'), `estatus`.
7. **Vista `master`**: `SELECT` consolidado con `LEFT JOIN` de las tablas de pacientes; incluye `parentesco` de admisión y `cantidad` de farmacia.

---

## 5. Ecosistema de Agentes (Azure AI Foundry)
Existen 6 agentes configurados. El backend se comunica principalmente con el Orquestador:
- `Agente-Orquestador` (punto de entrada del chat; delega según el rol y necesidad).
- `Agente-Admision` (identificación y alta de pacientes).
- `Agente-Historico` (gestión de antecedentes clínicos y alergias).
- `Agente-Seguros` (validación binaria de cobertura por estatus 'Activa').
- `Agente-Medico` (absorbe Triage, evalúa síntomas/signos vitales, genera notas SOAP, diagnósticos y recetas con validación previa de alergias).
- `Agente-Farmacia` (gestión puramente logística; consulta recetas y actualiza a 'Entregado').
- *Nota:* Queda prohibido crear o referenciar agentes de Triage o Asignación (fueron deprecados).

---

## 6. Arquitectura del Backend (`src/`)
- Backend modular TypeScript en `src/`, compilado a `dist/`; `src/bootstrap.ts` inicializa la instrumentación opcional y carga `src/server.ts`.
- Sirve la interfaz vanilla desde `public/` en la ruta raíz `/`.
- Expone los endpoints:
  - `GET /health` y `GET /healthz`: diagnóstico (`{ status: "ok" }`, HTTP 200).
  - `GET /auth/login`, `GET /auth/callback` y `POST /auth/logout`: autenticación.
  - `GET /api/me`: identidad y rol del empleado autenticado.
  - `POST /api/new-chat`: inicia una conversación nueva.
  - `POST /api/chat`: procesa una interacción autenticada.
- **Control de Acceso (RBAC):** Las operaciones conversacionales verifican la identidad y autorizan las herramientas según el rol del empleado.
- **Configuración de ejecución:** El puerto es `process.env.PORT` o `8000` por defecto.

---

## 7. Reglas de Seguridad
- No exponer contraseñas, connection strings ni llaves en código fuente o commits.
- Toda credencial se lee de variables de entorno:
  - Requeridas: `VITALIS_ENTRA_TENANT_ID`, `PROJECT_ENDPOINT`, `ORCHESTRATOR_AGENT_NAME`, `ADMISSION_AGENT_NAME`, `HISTORY_AGENT_NAME`, `INSURANCE_AGENT_NAME`, `CONSULTATION_AGENT_NAME`, `PHARMACY_AGENT_NAME`, `AZURE_SQL_CONNECTION_STRING` y `SESSION_SECRET`.
  - Inicio de sesión local: `MSAL_CLIENT_ID`, `MSAL_CLIENT_SECRET` y, opcionalmente, `AUTH_REDIRECT_URI` (por defecto, `http://localhost:8000/auth/callback`).
  - Telemetría opcional: `APPLICATIONINSIGHTS_CONNECTION_STRING`.
- Usa los nombres y valores de referencia de `.env.example`; nunca copies secretos de `.env`.
- En producción en Azure App Service, priorizar **Identidad Administrada (Managed Identity)** con el rol `Azure AI Developer` / `Cognitive Services OpenAI Contributor`.
- Validar que el mensaje sea texto no vacío y no exceda 8,000 caracteres; los payloads inválidos responden `400 Bad Request`.
- Los errores internos responden con un mensaje genérico `500 Internal Server Error`; no expongas trazas ni secretos al usuario.

---

## 8. Estilo de Código y Desarrollo
- Comentarios y documentación técnica en español neutro; variables y nombres de funciones en inglés.
- Código asíncrono limpio con `async/await`.
- Cambios mínimos y atómicos: modificar únicamente las funciones o secciones solicitadas, sin reescribir archivos enteros innecesariamente.

---

## 9. Criterios de Verificación Local
1. Instalar, compilar y probar: `npm ci`, `npm run build` y `npm test`.
2. Iniciar el servidor: `npm start` (requiere configuración local válida en `.env`).
3. Validar salud del servidor en PowerShell:
   ```powershell
   Invoke-RestMethod -Uri "http://localhost:8000/health"
   Invoke-RestMethod -Uri "http://localhost:8000/healthz"
   ```