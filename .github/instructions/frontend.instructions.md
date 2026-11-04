---
name: 'Frontend del chat'
description: 'Reglas para crear y mantener la interfaz web del chatbot hospitalario Vitalis.'
applyTo: 'public/**'
---
# Reglas del Frontend (Vitalis)

## 1. Stack y Dependencias
- Solo HTML5 semántico, CSS3 moderno y JavaScript vanilla (ES2020+).
- Prohibido el uso de frameworks (React, Vue, Angular) o librerías externas vía CDN.
- Todos los assets deben servirse localmente desde la carpeta `public/`.

## 2. Seguridad y Renderizado
- Inserta el texto de las respuestas con `textContent` para prevenir ataques XSS (Cross-Site Scripting). Prohibido usar `innerHTML` con entradas no sanitizadas.
- Para conservar los saltos de línea, viñetas y formato estructurado que devuelven los agentes de Vitalis, aplica la regla CSS `white-space: pre-wrap;` al contenedor de mensajes.

## 3. Estado de la Sesión y Conversación
- Guarda el `conversation_id` (o `thread_id`) en una variable en memoria de JS; debe reiniciarse limpiamente al recargar la página.
- Permite identificar el contexto del empleado activo (ID/Rol de la tabla `empleados`) para enviarlo en los headers o cuerpo de las peticiones hacia el backend.

## 4. Experiencia de Usuario (UX)
- Deshabilita el campo de texto y el botón de enviar mientras se espera la respuesta del servidor.
- Muestra un indicador visual claro de estado ("El asistente está respondiendo...").
- Mantén el scroll automático anclado al último mensaje generado.

## 5. Diseño y Estilos
- Diseño 100% responsivo y fluido (mobile-first), verificado para visualizarse correctamente desde 360 px de ancho.
- Paleta de colores hospitalaria/profesional definida con variables CSS en `:root`.
- Soporte nativo para modo oscuro mediante `@media (prefers-color-scheme: dark)`.