import { BusinessError, type Env } from "../types";
import { randomToken } from "./crypto";
export async function saveImage(
  env: Env,
  file: File,
  kind: "profiles" | "news",
) {
  if (file.size > 512 * 1024)
    throw new BusinessError(
      "La imagen optimizada supera 512 KB. Use el formulario para reducirla.",
    );
  const b = new Uint8Array(await file.arrayBuffer());
  let mime = "",
    w = 0,
    h = 0;
  if (
    b.length > 24 &&
    b[0] === 137 &&
    b[1] === 80 &&
    b[2] === 78 &&
    b[3] === 71 &&
    b[4] === 13 &&
    b[5] === 10 &&
    b[6] === 26 &&
    b[7] === 10
  ) {
    const view = new DataView(b.buffer);
    w = view.getUint32(16);
    h = view.getUint32(20);
    mime = "image/png";
  } else if (b.length > 4 && b[0] === 255 && b[1] === 216) {
    mime = "image/jpeg";
    let i = 2;
    while (i + 4 < b.length) {
      if (b[i++] !== 255) break;
      let marker = b[i++];
      while (marker === 255) marker = b[i++];
      if (marker === 218 || marker === 217) break;
      const len = (b[i] << 8) | b[i + 1];
      if (len < 2 || i + len > b.length) break;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker)
      ) {
        h = (b[i + 3] << 8) | b[i + 4];
        w = (b[i + 5] << 8) | b[i + 6];
        break;
      }
      i += len;
    }
  }
  if (!mime || !w || !h || w > 800 || h > 800)
    throw new BusinessError(
      "Use una imagen JPEG o PNG válida de hasta 800×800 píxeles.",
    );
  const key = `${kind}/${randomToken()}.${mime === "image/jpeg" ? "jpg" : "png"}`;
  await env.FILES.put(key, b, {
    httpMetadata: { contentType: mime },
    customMetadata: { width: String(w), height: String(h) },
  });
  return key;
}
