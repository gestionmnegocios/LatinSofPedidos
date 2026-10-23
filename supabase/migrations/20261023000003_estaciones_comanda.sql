-- ============================================================
-- Comandas separadas: cada categoría pertenece a una estación
-- ('cocina' o 'bar'). Al imprimir, cada ronda se divide en una comanda
-- de cocina (comidas) y una de bar (bebidas y licores).
-- Cambio aditivo: la versión anterior de la app ignora la columna.
-- ============================================================

alter table public.categorias add column if not exists estacion text not null default 'cocina';
alter table public.categorias drop constraint if exists categorias_estacion_valida;
alter table public.categorias add constraint categorias_estacion_valida check (estacion in ('cocina', 'bar'));

-- Lo que ya existe: las bebidas van al bar
update public.categorias set estacion = 'bar' where id = 'cat-bebidas';

-- Categoría nueva para licores (al bar), al final del menú
insert into public.categorias (id, restaurante_id, nombre, orden, estacion)
select 'cat-licores', r.id, 'Licores',
       coalesce((select max(orden) from public.categorias where restaurante_id = r.id), 0) + 1, 'bar'
from public.restaurantes r where r.id = 'rest-fogon'
on conflict (id) do nothing;

-- Caja puede cambiar la estación de las categorías de su restaurante
grant update (estacion) on public.categorias to authenticated;
drop policy if exists auth_admin_modificar on public.categorias;
create policy auth_admin_modificar on public.categorias for update to authenticated
  using (restaurante_id = (select private.mi_restaurante()) and (select private.mi_rol()) = 'admin')
  with check (restaurante_id = (select private.mi_restaurante()));
