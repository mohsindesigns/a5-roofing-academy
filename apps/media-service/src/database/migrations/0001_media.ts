import { addUpdatedAtTrigger, createOutboxTable, createUpdatedAtFunction, sql, type Kysely } from '@a5/database';

export async function up(db: Kysely<unknown>): Promise<void> {
  await createUpdatedAtFunction(db);
  await createOutboxTable(db);

  await sql`
    create table media_assets (
      id uuid primary key,
      organization_id uuid not null,
      kind text not null check (kind in ('video', 'document', 'image', 'caption')),
      title text not null,
      description text,
      original_filename text not null,
      storage_key text not null unique,
      mime_type text not null,
      size_bytes bigint not null check (size_bytes > 0),
      checksum text,
      status text not null check (status in (
        'awaiting_upload', 'uploaded', 'scanning', 'processing', 'ready', 'failed', 'rejected', 'archived'
      )),
      scan_status text not null default 'pending' check (scan_status in ('pending', 'clean', 'infected', 'skipped', 'error')),
      duration_seconds numeric(12, 3) check (duration_seconds is null or duration_seconds >= 0),
      width integer check (width is null or width > 0),
      height integer check (height is null or height > 0),
      hls_master_key text,
      thumbnail_key text,
      error text,
      parent_asset_id uuid references media_assets(id),
      uploaded_at timestamptz,
      ready_at timestamptz,
      archived_at timestamptz,
      created_by uuid not null,
      updated_by uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check ((kind = 'caption') = (parent_asset_id is not null)),
      check ((status = 'archived') = (archived_at is not null))
    );
    -- Library: newest first per organization, filtered by kind and/or status.
    create index media_assets_org_created_idx on media_assets (organization_id, created_at desc, id);
    create index media_assets_org_kind_idx on media_assets (organization_id, kind, created_at desc);
    create index media_assets_org_status_idx on media_assets (organization_id, status, created_at desc);
    create index media_assets_parent_idx on media_assets (parent_asset_id) where parent_asset_id is not null;
    -- Sweeper: uploads that never reached the processing queue.
    create index media_assets_pending_idx on media_assets (updated_at) where status in ('uploaded', 'scanning', 'processing');

    create table media_renditions (
      id uuid primary key,
      asset_id uuid not null references media_assets(id) on delete cascade,
      name text not null,
      width integer not null check (width > 0),
      height integer not null check (height > 0),
      bandwidth integer not null check (bandwidth > 0),
      codecs text,
      playlist_key text not null,
      created_at timestamptz not null default now(),
      unique (asset_id, name)
    );

    create table media_captions (
      id uuid primary key,
      asset_id uuid not null references media_assets(id) on delete cascade,
      caption_asset_id uuid not null unique references media_assets(id) on delete cascade,
      language text not null,
      label text not null,
      storage_key text not null,
      is_default boolean not null default false,
      created_by uuid not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create unique index media_captions_label_uq on media_captions (asset_id, language, lower(label));
    create unique index media_captions_default_uq on media_captions (asset_id) where is_default;

    create table media_chapters (
      id uuid primary key,
      asset_id uuid not null references media_assets(id) on delete cascade,
      start_seconds numeric(12, 3) not null check (start_seconds >= 0),
      title text not null,
      position integer not null check (position > 0),
      created_by uuid,
      updated_by uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (asset_id, start_seconds)
    );
    create index media_chapters_asset_idx on media_chapters (asset_id, position);

    create table media_transcripts (
      id uuid primary key,
      asset_id uuid not null references media_assets(id) on delete cascade,
      language text not null,
      segments jsonb not null,
      updated_by uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (asset_id, language)
    );

    create table video_progress (
      id uuid primary key,
      organization_id uuid not null,
      user_id uuid not null,
      asset_id uuid not null references media_assets(id),
      context_type text not null,
      context_id uuid not null,
      watched_seconds numeric(12, 3) not null default 0 check (watched_seconds >= 0),
      duration_seconds numeric(12, 3) not null check (duration_seconds > 0),
      percent numeric(5, 2) not null default 0 check (percent between 0 and 100),
      last_position_seconds numeric(12, 3) not null default 0 check (last_position_seconds >= 0),
      intervals jsonb not null default '[]',
      started_at timestamptz not null,
      completed_at timestamptz,
      milestones_emitted integer[] not null default '{}',
      updated_at timestamptz not null default now(),
      unique (user_id, asset_id, context_type, context_id)
    );
    create index video_progress_asset_idx on video_progress (asset_id);
    create index video_progress_org_user_idx on video_progress (organization_id, user_id, updated_at desc);
  `.execute(db);

  for (const table of ['media_assets', 'media_captions', 'media_chapters', 'media_transcripts', 'video_progress']) {
    await addUpdatedAtTrigger(db, table);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop table if exists video_progress, media_transcripts, media_chapters, media_captions, media_renditions,
      media_assets, outbox_events cascade;
    drop function if exists set_updated_at();
  `.execute(db);
}
