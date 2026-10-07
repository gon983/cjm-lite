# Contraseñas y transición a Workers Free

## Decisiones explícitas

El usuario autorizó iniciar Cloudflare sin las cuentas/contraseñas anteriores. Hay cuatro cuentas bcrypt en la copia original; no se importaron a D1 activo. La base y un dump completo se conservan en un archivo privado para revisión/rollback. No se prometió verificar bcrypt en 10 ms ni se invalidó una contraseña importada silenciosamente.

El usuario también autorizó derivar las contraseñas en el navegador para el plan Free. La pantalla continúa siendo DNI/usuario + contraseña, pero requiere JavaScript y HTTPS (localhost es un contexto seguro de desarrollo).

## Algoritmo

1. Salt aleatorio de 32 bytes por contraseña, nuevo al registrar/resetear.
2. Navegador: PBKDF2-HMAC-SHA256 estándar, 600.000 iteraciones, salida 32 bytes.
3. Worker: HMAC-SHA256 con SESSION_SECRET sobre `password:<salt>:<derivedProof>`.
4. D1: `client-pbkdf2-sha256$600000$<salt>$<HMAC>`. No guarda la contraseña, la prueba derivada ni el token de sesión.
5. Login solicita el salt. Cuentas inexistentes reciben un salt del mismo formato para evitar un resultado explícito de enumeración. Navegador deriva y envía la prueba por HTTPS; el Worker compara el HMAC en tiempo constante.

La prueba derivada es una credencial sensible en tránsito, equivalente a enviar una contraseña por TLS: nunca se registra en logs ni persiste. Un HMAC robado de D1 no permite autenticar directamente porque se requiere la prueba anterior al HMAC; la clave del Worker añade protección ante una copia de D1 aislada. No se introduce un protocolo de desafío ni una construcción PBKDF2 personalizada. La derivación es Web Crypto estándar; el almacenamiento versiona su esquema explícitamente.

El backend valida formatos (salt/prueba de 64 hex), permisos, DNI y límites. La longitud de la contraseña original (12–72 bytes) se comprueba en browser/CLI y se declara al backend: el backend no puede demostrar esa longitud porque deliberadamente no recibe el texto original. Un cliente manipulado puede elegir una credencial débil para su propia cuenta, como también puede elegir un texto predecible en un formulario tradicional. No confundir este dato declarado con una verificación criptográfica de longitud/entropía. Las reglas de autorización, registro habilitado y exclusión concurrente permanecen exclusivamente en backend.

## Secreto, restablecimientos y sesiones

SESSION_SECRET debe ser aleatorio y conservarse fuera de Git. Cambiarlo invalida verificadores de contraseña y CSRF; requiere reestablecer las contraseñas o una migración planificada. Restaure la misma clave junto con D1. No rotarlo como una cookie efímera. Un administrador resetea la contraseña manualmente; no hay SMTP. Resetear o desactivar elimina las sesiones anteriores. Cada login crea un token de 256 bits, guarda SHA-256 del token en D1, vence a 12 horas y rota las cookies HttpOnly/Secure/SameSite=Lax.

## Primer administrador

Usar `npm run bootstrap -- 'Nombre' usuario [APP_URL]` con contraseña por stdin, nunca argumentos. El script usa Node Web Crypto solo como herramienta local, hace la misma derivación estándar y llama el bootstrap autenticado con BOOTSTRAP_SECRET. SQL permite crear únicamente si no existe ningún ADMIN. Eliminar BOOTSTRAP_SECRET remoto después de crear el primer administrador. Los siguientes se crean en el panel.

## Justificación y medición

Workers Free HTTP tiene presupuesto de CPU de 10 ms: https://developers.cloudflare.com/workers/platform/limits/ . El máximo nativo de PBKDF2 no equivale al workerd local; Cloudflare discute el límite de 100k en https://github.com/cloudflare/workerd/pull/7550 . Local puede aceptar 600k, por lo que pasar tests locales no prueba que funcionen remotamente. Se eligió sacar PBKDF2 y bcrypt del Worker, no reducir arbitrariamente el costo del hash.

La CPU remota real debe medirse en la cuenta de Cloudflare después de desplegar. La verificación del Worker solo requiere una consulta indexada, HMAC nativo, un batch para sesión y contadores de login. No se afirma que los tests locales certifiquen la cuota remota.
