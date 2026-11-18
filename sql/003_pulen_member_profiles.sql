-- Khusus instalasi awal V3. Jangan jalankan berulang pada skema dari versi lain
-- tanpa memeriksa kolom. V1/V2 tidak pernah dipasang dalam alur ini.
BEGIN;
CREATE TABLE IF NOT EXISTS public.pulen_member_profiles (
  pulen_user_id integer PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  first_name varchar(100) NOT NULL,
  last_name varchar(100),
  birth_place varchar(120) NOT NULL,
  birth_date date NOT NULL,
  address text NOT NULL,
  occupation varchar(100) NOT NULL,
  rt varchar(3),
  rw varchar(3),
  province varchar(100),
  city varchar(100),
  district varchar(100),
  village varchar(100),
  source varchar(24) NOT NULL DEFAULT 'self_reported',
  completed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
