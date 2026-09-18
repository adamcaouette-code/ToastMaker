const { api } = require("./_anthropic");

// Maps onto Design's { notes: [{ id, title, date, body }] } shape.
// Design's "title" is derived from the filename since Strategy-Review's
// prompt doesn't currently pin down a fixed title field inside the file.

exports.handler = async () => {
  try {
    const { MEMORY_STORE_ID } = process.env;
    if (!MEMORY_STORE_ID) throw new Error("Missing env var: MEMORY_STORE_ID");

    const result = await api(
      `/memory_stores/${MEMORY_STORE_ID}/memories?view=full&limit=100`,
      { method: "GET" }
    );

    const files = (result.data || [])
      .filter((f) => /review/i.test(f.path))
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    const notes = files.map((f) => ({
      id: f.path,
      title: f.path.split("/").pop().replace(/\.md$/i, "").replace(/[-_]/g, " "),
      date: new Date(f.updated_at).toLocaleDateString(),
      body: f.content || "",
    }));

    return { statusCode: 200, body: JSON.stringify({ notes }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
