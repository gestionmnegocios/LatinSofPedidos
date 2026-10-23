-- ============================================================
-- Imágenes de productos (menú táctil del mesero)
--
-- * productos.imagen_url: URL pública de la foto del producto.
-- * Bucket de Storage "productos": lectura pública (son fotos del menú,
--   se muestran con <img>), escritura solo para caja/administración y
--   solo dentro de la carpeta de su restaurante: <restaurante_id>/archivo.
-- Cambio aditivo: no afecta a la versión anterior de la app.
-- ============================================================

alter table public.productos add column if not exists imagen_url text;
alter table public.productos drop constraint if exists productos_imagen_url_https;
alter table public.productos add constraint productos_imagen_url_https
  check (imagen_url is null or imagen_url ~ '^https://');

-- La política auth_admin_modificar ya limita UPDATE a caja de su restaurante.
grant update (imagen_url) on public.productos to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('productos', 'productos', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- (las URL públicas no pasan por estas políticas; estas controlan la API
-- autenticada de Storage: listar, subir, reemplazar y borrar)
drop policy if exists productos_img_admin_leer on storage.objects;
drop policy if exists productos_img_admin_subir on storage.objects;
drop policy if exists productos_img_admin_modificar on storage.objects;
drop policy if exists productos_img_admin_borrar on storage.objects;

create policy productos_img_admin_leer on storage.objects for select to authenticated
  using (bucket_id = 'productos'
         and (storage.foldername(name))[1] = (select private.mi_restaurante())
         and (select private.mi_rol()) = 'admin');
create policy productos_img_admin_subir on storage.objects for insert to authenticated
  with check (bucket_id = 'productos'
              and (storage.foldername(name))[1] = (select private.mi_restaurante())
              and (select private.mi_rol()) = 'admin');
create policy productos_img_admin_modificar on storage.objects for update to authenticated
  using (bucket_id = 'productos'
         and (storage.foldername(name))[1] = (select private.mi_restaurante())
         and (select private.mi_rol()) = 'admin')
  with check (bucket_id = 'productos'
              and (storage.foldername(name))[1] = (select private.mi_restaurante()));
create policy productos_img_admin_borrar on storage.objects for delete to authenticated
  using (bucket_id = 'productos'
         and (storage.foldername(name))[1] = (select private.mi_restaurante())
         and (select private.mi_rol()) = 'admin');
