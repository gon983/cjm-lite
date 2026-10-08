# Logs técnicos de producción

Se usan exclusivamente **Cloudflare Workers Logs / Observability**. No existe tabla, bucket ni archivo de logs técnicos en la aplicación. `audit_log` de D1 permanece como registro funcional de negocio y participa en batches transaccionales. Su pantalla fue retirada a pedido del usuario.

## Configuración

```toml
[observability]
enabled = true
head_sampling_rate = 1

[observability.logs]
enabled = true
invocation_logs = false
```

Cloudflare Free ofrece actualmente tres días de retención automática y 200.000 eventos diarios. No se implementa almacenamiento propio para forzar 48 horas. La configuración no fija una retención artificial; acepta la política del proveedor. [Documentación oficial](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).

## Eventos y correlación

Helper único `src/lib/logging.ts`, que emite objetos JSON indexables por Cloudflare. Ejemplo sin datos personales:

```json
{"level":"info","event":"mediation_created","request_id":"uuid","route":"/reservar","method":"POST","user_id":12,"role":"MEDIADOR","entity":"mediations","entity_id":23,"duration_ms":18}
```

Se registran login fallido, creación/cancelación/modificación/conflictos de mediación, cambios de estado, acciones administrativas, perfil actualizado y fallos inesperados. Los GET/HTMX exitosos, assets y cada query SQL no se registran. Una operación rechazada o un fallo sí puede generar un evento. `duration_ms` mide tiempo de atención, incluido I/O, y **no es una medición de CPU de Workers**.

Cada petición tiene un UUID interno, incluido en `X-Request-ID`. No se reutiliza un ID no confiable enviado por el cliente. Las rutas dinámicas se normalizan (`/uploads/*`, `/admin/descargar/:file`), sin keys privadas ni query strings.

El helper acepta solo campos técnicos permitidos. No recibe bodies, cookies, credenciales, IP, emails, DNI o nombres. Los errores internos se convierten a tipo/código, diagnóstico seguro y ubicaciones limitadas de código; el mensaje bruto del error y el stack completo no se imprimen. El usuario recibe un mensaje claro genérico, nunca el stack.

## Consulta

Cloudflare → Workers & Pages → cjm-lite → Observability → Logs. Filtrar por `event`, `request_id`, `user_id`, `entity_id`, `level` o `error_code`. Para observar durante una prueba: `npx wrangler tail --format=json`.

La auditoría funcional de negocio en D1 conserva quién/acción/entidad/timestamp mínimos. No se usa como almacenamiento de eventos técnicos. Login_attempts es estado de rate limiting con TTL, no una tabla de logs.
