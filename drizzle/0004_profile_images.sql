-- Susu Protocol — the profile-image bucket, its access control, and the column
-- that points into it.
--
-- WHY THIS IS A MIGRATION AND NOT A DASHBOARD CLICK
-- A bucket created by hand is invisible to review and impossible to reproduce: a
-- `public = true` left behind by an experiment makes every object world-readable
-- through Storage's public URL path, and nothing in the repository would show it.
-- The insert below therefore *converges* rather than skipping when the bucket
-- already exists, so the security-relevant configuration is re-asserted on every
-- apply instead of trusting whatever was there.
--
-- WHAT THE BROWSER MAY DO DIRECTLY
-- A user uploads to and deletes from this bucket with the publishable key, under
-- the policies below, and then tells the API which object key they used. The API
-- never handles image bytes and never returns a URL: it stores and validates a
-- path. That keeps the service-role key out of the browser without putting an
-- image through this service.
--
-- WHY THE FOLDER IS `users/<uuid>/avatar/`
-- The first two segments are the ownership boundary the policies match on, and
-- the third leaves room for other per-user objects without ever widening the
-- prefix. Ownership is by the authenticated session's subject, never by a value
-- in the request.
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The bucket.
--
-- PRIVATE (`public = false`). These are profile photos, which is not the same
-- thing as public data: they are shown in the app to people who are entitled to
-- see them, through a signed URL that expires. A public bucket would make every
-- avatar readable by anyone who can guess the path, forever, with no way to
-- revoke that — and paths contain a user id, so guessing is not the barrier.
--
-- The size limit and MIME allow-list are enforced by Storage on upload, which is
-- the only place enforcement can be trusted. The browser validates the same
-- things, for a fast, clear error, but a client-side check is a courtesy.
--
-- 2 MiB is generous for an avatar and small enough that the limit is a limit.
-- The three accepted types are the ones `image/webp`, `image/jpeg` and
-- `image/png` — the document's list, with `jpg` folded into `jpeg` because that
-- is what the MIME type actually is.
-- ---------------------------------------------------------------------------
do $$
begin
  -- Guarded like the `auth.users` foreign key in `0000_profiles.sql`: against a
  -- database without Storage installed this migration is a no-op rather than a
  -- failure. CI installs the shim, so the policies below are exercised there.
  if to_regclass('storage.buckets') is null then
    raise notice 'profile-images: storage schema absent — skipping bucket and policies.';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'profile-images',
    'profile-images',
    false,
    2097152,
    array['image/png', 'image/jpeg', 'image/webp']
  )
  on conflict (id) do update
    set public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
end
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Policies on storage.objects: a user owns exactly their own prefix.
--
-- Every policy matches on `(storage.foldername(name))[2]` — the `<uuid>` in
-- `users/<uuid>/avatar/<name>` — against `auth.uid()`, the verified session
-- subject. The first segment is checked too, so a path that merely happens to
-- have the user's id in second position, under some other top-level folder, is
-- not covered by these policies.
--
-- Written as drop-then-create so re-applying converges. There is no `DROP POLICY
-- IF EXISTS` on a policy this migration did not create, so nothing else in the
-- schema is affected.
--
-- NO SELECT POLICY FOR OTHER USERS. An avatar is readable by its owner only.
-- Showing one member's photo to another would need a policy that joins to group
-- membership, which is a decision about what group data means rather than about
-- who owns an object; it is not made here, and the consequence is that the app
-- must not render other members' avatars until it is.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'profile-images: storage.objects absent — skipping policies.';
    return;
  end if;

  execute 'drop policy if exists profile_images_select_own on storage.objects';
  execute $policy$
    create policy profile_images_select_own on storage.objects
      for select
      to authenticated
      using (
        bucket_id = 'profile-images'
        and (storage.foldername(name))[1] = 'users'
        and (storage.foldername(name))[2] = auth.uid()::text
      )
  $policy$;

  execute 'drop policy if exists profile_images_insert_own on storage.objects';
  execute $policy$
    create policy profile_images_insert_own on storage.objects
      for insert
      to authenticated
      with check (
        bucket_id = 'profile-images'
        and (storage.foldername(name))[1] = 'users'
        and (storage.foldername(name))[2] = auth.uid()::text
      )
  $policy$;

  -- Update is what `upsert` uses. Both clauses are required: without `with check`
  -- a user could move an object they own into another user's prefix, which would
  -- hand it to them and take it out of the owner's reach.
  execute 'drop policy if exists profile_images_update_own on storage.objects';
  execute $policy$
    create policy profile_images_update_own on storage.objects
      for update
      to authenticated
      using (
        bucket_id = 'profile-images'
        and (storage.foldername(name))[1] = 'users'
        and (storage.foldername(name))[2] = auth.uid()::text
      )
      with check (
        bucket_id = 'profile-images'
        and (storage.foldername(name))[1] = 'users'
        and (storage.foldername(name))[2] = auth.uid()::text
      )
  $policy$;

  -- Deleting an object is how a user removes their photo, so this policy is
  -- required for the feature. It is scoped to their own prefix, so it is not a
  -- way to reach anyone else's.
  execute 'drop policy if exists profile_images_delete_own on storage.objects';
  execute $policy$
    create policy profile_images_delete_own on storage.objects
      for delete
      to authenticated
      using (
        bucket_id = 'profile-images'
        and (storage.foldername(name))[1] = 'users'
        and (storage.foldername(name))[2] = auth.uid()::text
      )
  $policy$;
end
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- `profiles.avatar_path` is a path in this bucket, and the shape constraint is
-- what makes that true rather than aspirational.
--
-- The browser holds `update (display_name, avatar_path)` on this table, so the
-- column is writable by the client. `PATCH /me` validates it too, but a policy
-- about which fields may change is not a statement about what they may contain,
-- and the runtime check lives in one service while the column is writable by
-- two writers. The constraint is the part that cannot be bypassed.
--
-- It is deliberately strict, because every looseness here has to be justified
-- somewhere else:
--
--   * `users/<uuid>/avatar/` — the prefix the Storage policies match on. A path
--     outside that prefix is an object the user cannot read, write or delete, so
--     storing one would break their own profile.
--   * the `<uuid>` must equal the row's own `user_id`, which is what stops a
--     profile pointing at somebody else's object.
--   * the name is 32 lowercase hex characters — a generated name, not a
--     user-supplied one. A name chosen by the uploader is where a `.php`
--     extension, a traversal sequence, or a second extension comes from, and
--     refusing the whole class is simpler than enumerating what is forbidden.
--   * the extension is one of the three accepted formats, in lowercase.
--
-- `avatar_path is null` is allowed and means "no photo", which is the state
-- every account starts in and the state a removal returns to.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add constraint profiles_avatar_path_shape
  check (
    avatar_path is null
    or avatar_path ~ (
      '^users/'
      || user_id::text
      || '/avatar/[0-9a-f]{32}\.(png|jpe?g|webp)$'
    )
  );
--> statement-breakpoint
