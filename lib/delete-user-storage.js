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

  for (const ownerColumn of ['owner_id', 'owner']) {
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .schema('storage')
        .from('objects')
        .select('bucket_id, name')
        .eq(ownerColumn, userId)
        .order('bucket_id', { ascending: true })
        .order('name', { ascending: true })
        .range(offset, offset + pageSize - 1);

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

  // Verify that neither current nor legacy ownership metadata remains.
  for (const ownerColumn of ['owner_id', 'owner']) {
    const { count, error } = await supabase
      .schema('storage')
      .from('objects')
      .select('id', { count: 'exact', head: true })
      .eq(ownerColumn, userId);

    if (error) {
      throw new Error(`Could not verify Storage cleanup (${ownerColumn}): ${error.message}`);
    }
    if (count > 0) {
      throw new Error(`Storage cleanup incomplete: ${count} owned object(s) remain.`);
    }
  }

  return { removed };
}
