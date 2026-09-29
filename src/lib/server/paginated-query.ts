type QueryPage<T> = {
  data: T[] | null;
  error: { message?: string } | null;
};

export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<QueryPage<T>>,
  pageSize = 1000,
): Promise<QueryPage<T>> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await fetchPage(offset, offset + pageSize - 1);
    if (error) return { data: null, error };
    rows.push(...(data || []));
    if ((data || []).length < pageSize) return { data: rows, error: null };
  }
}
