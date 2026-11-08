/**
 * Remove all Storage objects owned by a Supabase Auth user.
 *
 * Supabase Auth refuses to delete users who still own Storage objects.
 * Discover ownership through storage.objects, but remove files through the
 * Storage API (never by deleting storage.objects rows with SQL).
 */
export async function deleteUserStorageObjects(supabase, userId) {
  const objects = new Map();
  const pageSize = 1000;

  {
    let offset = 0;
    while (true) {
      const { data, error } = await supabase.rpc('admin_list_user_storage_objects', {
        p_user_id: userId,
        p_offset: offset,
        p_limit: pageSize
      });

      if (error) {
        throw new Error(`Could not inspect Storage ownership (${ownerColumn}): ${error.message}`);
      }

      for (const item of data || []) {
        if (item.bucket_id && item.name) {
          objects.set(`${item.bucket_id}/${item.name}`, {
            bucket: item.bucket_id,
            name: item.name
          });
        }
      }

      if (!data || data.length < pageSize) break;
      offset += pageSize;
    }
  }

  const byBucket = new Map();
  for (const item of objects.values()) {
    if (!byBucket.has(item.bucket)) byBucket.set(item.bucket, []);
    byBucket.get(item.bucket).push(item.name);
  }

  let removed = 0;
  for (const [bucket, paths] of byBucket.entries()) {
    for (let i = 0; i < paths.length; i += pageSize) {
      const batch = paths.slice(i, i + pageSize);
      const { error } = await supabase.storage.from(bucket).remove(batch);
      if (error) {
        throw new Error(`Could not remove Storage files from "${bucket}": ${error.message}`);
      }
      removed += batch.length;
    }
  }

  // Verify through the restricted service-role-only database function.
  const { data: remaining, error: verifyError } = await supabase.rpc('admin_list_user_storage_objects', {
    p_user_id: userId,
    p_offset: 0,
    p_limit: 1
  });
  if (verifyError) {
    throw new Error(`Could not verify Storage cleanup: ${verifyError.message}`);
  }
  if (remaining && remaining.length > 0) {
    throw new Error('Storage cleanup incomplete: owned objects remain.');
  }

  return { removed };
}
