import type { Env, News } from "../types";
import { BusinessError } from "../types";
import { stmt, stamp, adminSQL, auditAfter } from "./database";
import { validDate, dateInput } from "../lib/dates";
export async function saveNews(
  env: Env,
  actor: number,
  data: Record<string, string>,
  image: string,
) {
  const id = Number(data.id) || 0;
  let write: D1PreparedStatement;
  if (data.action === "delete")
    write = stmt(env, `DELETE FROM news WHERE id=? AND ${adminSQL}`, id, actor);
  else {
    const date = dateInput(data.date);
    if (
      !data.title?.trim() ||
      data.title.length > 200 ||
      !data.content?.trim() ||
      data.content.length > 20000 ||
      !validDate(date)
    )
      throw new BusinessError("Complete título, contenido y fecha válida.");
    if (id)
      write = stmt(
        env,
        `UPDATE news SET title=?,content=?,image=CASE WHEN ?='' THEN image ELSE ? END,published=?,publication_date=?,updated_at=? WHERE id=? AND ${adminSQL}`,
        data.title,
        data.content,
        image,
        image,
        data.published === "1" ? 1 : 0,
        date,
        stamp(),
        id,
        actor,
      );
    else
      write = stmt(
        env,
        `INSERT INTO news(title,content,image,published,publication_date,updated_at) SELECT ?,?,?,?,?,? WHERE ${adminSQL}`,
        data.title,
        data.content,
        image,
        data.published === "1" ? 1 : 0,
        date,
        stamp(),
        actor,
      );
  }
  const [r] = await env.DB.batch([
    write,
    auditAfter(
      env,
      actor,
      data.action === "delete" ? "DELETE_NEWS" : "SAVE_NEWS",
      "news",
      id || null,
    ),
  ]);
  if (r.meta.changes !== 1)
    throw new BusinessError("La noticia no existe o no tiene permiso.", 403);
}
