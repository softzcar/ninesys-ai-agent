# Changelog

## [v0.1.0] - 2026-09-28
- Versión inicial del agente reutilizable de IA del ecosistema Ninesys.
- Cliente MCP (SDK oficial) + puente a Gemini (functionDeclarations) + bucle de tool-use.
- Modo librería (createNinesysAgent) y modo servicio HTTP (POST /chat con Bearer + CORS).
- Empresa por conversación vía cabecera X-Ninesys-Empresa al MCP; el LLM no la maneja.
- Resiliencia: timeout + reintentos + circuit breaker por canal.
