-- Photos for the public site's image slots (homepage, About page, sign-up), uploaded by admins.
-- The list of slots lives in src/lib/site-images.js; a slot with no row shows a branded placeholder.
CREATE TABLE site_images (
  slot        text PRIMARY KEY,
  mime        text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  data        bytea NOT NULL,
  byte_size   integer NOT NULL,
  width       integer NOT NULL,
  height      integer NOT NULL,
  alt         text NOT NULL DEFAULT '',
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
