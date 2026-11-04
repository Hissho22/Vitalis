---
name: 'Backend Express'
description: 'Reglas para crear y mantener el backend Node.js 24 LTS con Express, Azure AI Foundry y Azure SQL.'
applyTo: 'src/**, scripts/**'
---
# Reglas del Backend (Vitalis)

## 1. Clientes y Conexiones (Inicialización Única)
- Conserva la arquitectura modular TypeScript existente (`src/server.ts`, `src/ai.ts` y `src/db.ts`); no crees un backend paralelo en `server.js`.
- Inicializa el cliente de Azure AI Foundry una sola vez al arrancar, nunca dentro del ciclo de cada solicitud.
- Centraliza la conexión Azure SQL en `src/db.ts` usando el pool reutilizable de `mssql`.
- Todas las consultas SQL deben usar parámetros para los valores de entrada.
- Lee los nombres vigentes de configuración de `.env.example`, incluida `PROJECT_ENDPOINT` y `AZURE_SQL_CONNECTION_STRING`; no introduzcas nombres alternativos sin actualizar la configuración y su documentación.

## 2. Invocación de Agentes en Foundry
- Usa el `AIProjectClient` compartido y crea clientes de agente con `project.getOpenAIClient({ azureConfig: { allowPreview: true, agentName } })`.
- Invoca las respuestas mediante `client.responses.create(...)`, siguiendo los patrones existentes en `src/ai.ts`.
- El backend expone rutas claras para que el frontend hable con el Orquestador o consulte el expediente.

## 3. Manejo de Errores y Rutas
- Maneja errores de Azure SQL y Azure AI Foundry con respuestas controladas y mensajes genéricos; no filtres trazas, cadenas de conexión ni contraseñas.
- Resuelve rutas respecto al módulo, nunca con rutas relativas dependientes del directorio de ejecución.
- Mantén `GET /health` y `GET /healthz`; ambos deben devolver HTTP 200 y `{ status: "ok" }`.
- El puerto es `process.env.PORT` o `8000` por defecto.

## 4. Control de Dependencias
- No agregues librerías nuevas al `package.json` a menos que estén explícitamente autorizadas en el plan del Arquitecto.