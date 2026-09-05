import { createRequire } from "module";

const nodeRequire = createRequire(import.meta.url);

type BookmarkRow = Record<string, unknown>;
type BookmarkModel = { version: number; bookmarks: BookmarkRow[] };
type ImportResult =
  | { ok: true; model: BookmarkModel }
  | { ok: false; reason: "invalid" | "empty" };

const Bookmarks = nodeRequire("../../../extension/bookmarks.js") as {
  importBackup: (text: string, hamhome: unknown) => ImportResult;
  modelToJsonText: (model: unknown) => string;
  normalizeModel: (raw: unknown) => BookmarkModel;
  parseHtml: (text: string) => BookmarkModel;
  sniffJsonImport: (
    text: string
  ) => { flavor: "davflare" | "hamhome"; parsed: unknown } | null;
  urlKey: (url: unknown) => string;
};

const HamHome = nodeRequire("../../../extension/hamhome.js") as {
  importFrom: (
    meta: unknown,
    categories: unknown
  ) => { ok: boolean; model: BookmarkModel };
};

const DAVFLARE_JSON = JSON.stringify({
  version: 1,
  bookmarks: [
    {
      id: "bm-1",
      title: "Docs",
      url: "https://docs.example/",
      folder: "Dev/Rust",
      tags: ["dev"],
      note: "handbook",
      added: 1690000100000,
    },
  ],
});

const HAMHOME_JSON = JSON.stringify({
  bookmarks: [
    {
      title: "Docs",
      url: "https://docs.example/",
      categoryId: "c1",
      tags: ["dev"],
      description: "handbook",
      createdAt: 1690000100000,
    },
    {
      title: "Deleted",
      url: "https://gone.example/",
      categoryId: "c2",
      isDeleted: true,
    },
  ],
  categories: [
    { id: "c1", name: "Rust", parentId: "root" },
    { id: "root", name: "Dev", parentId: null },
  ],
});

describe("extension/bookmarks.js sniffJsonImport (issue #65)", () => {
  test("detects Davflare and HamHome shapes", () => {
    expect(Bookmarks.sniffJsonImport(DAVFLARE_JSON)?.flavor).toBe("davflare");
    expect(Bookmarks.sniffJsonImport(HAMHOME_JSON)?.flavor).toBe("hamhome");
    expect(
      Bookmarks.sniffJsonImport('[{"url":"https://a.com","createdAt":1,"description":"x"}]')
        ?.flavor
    ).toBe("hamhome");
  });

  test("defaults plain or empty bookmark arrays to Davflare", () => {
    expect(Bookmarks.sniffJsonImport('{"bookmarks":[{"url":"https://a.com"}]}')?.flavor).toBe(
      "davflare"
    );
    expect(Bookmarks.sniffJsonImport('{"bookmarks":[]}')?.flavor).toBe("davflare");
  });

  test("rejects non-bookmark JSON", () => {
    expect(Bookmarks.sniffJsonImport("not json")).toBeNull();
    expect(Bookmarks.sniffJsonImport("<DL><p></DL><p>")).toBeNull();
    expect(Bookmarks.sniffJsonImport('{"nope":1}')).toBeNull();
  });
});

describe("extension/bookmarks.js importBackup (issue #65)", () => {
  test("parses Davflare JSON with rich fields intact", () => {
    const res = Bookmarks.importBackup(DAVFLARE_JSON, HamHome);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.model.bookmarks[0]).toMatchObject({
      id: "bm-1",
      folder: "Dev/Rust",
      tags: ["dev"],
      note: "handbook",
      added: 1690000100000,
    });
  });

  test("parses HamHome JSON with inline categories, skipping deleted rows", () => {
    const res = Bookmarks.importBackup(HAMHOME_JSON, HamHome);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.model.bookmarks).toHaveLength(1);
    expect(res.model.bookmarks[0]).toMatchObject({
      title: "Docs",
      url: "https://docs.example/",
      folder: "Dev/Rust",
      note: "handbook",
      tags: ["dev"],
      added: 1690000100000,
    });
  });

  test("parses HamHome bare array without categories as unfiled", () => {
    const res = Bookmarks.importBackup(
      '[{"title":"A","url":"https://a.com","categoryId":"zz"}]',
      HamHome
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.model.bookmarks[0]).toMatchObject({ url: "https://a.com", folder: "" });
  });

  test("parses Netscape HTML with folder paths", () => {
    const res = Bookmarks.importBackup(
      '<DL><p><DT><H3>Dev</H3><DL><p><DT><A HREF="https://a.com" ADD_DATE="1690000100">A</A></DL><p></DL><p>',
      HamHome
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.model.bookmarks).toHaveLength(1);
    expect(res.model.bookmarks[0]).toMatchObject({ url: "https://a.com", folder: "Dev" });
  });

  test("round-trips its own JSON export", () => {
    const model = Bookmarks.normalizeModel({
      bookmarks: [{ id: "b1", url: "https://a.com", title: "A", tags: ["t"] }],
    });
    const res = Bookmarks.importBackup(Bookmarks.modelToJsonText(model), HamHome);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.model.bookmarks[0]).toMatchObject({ id: "b1", tags: ["t"] });
    expect(Bookmarks.urlKey(res.model.bookmarks[0].url as string)).toBe(
      Bookmarks.urlKey("https://a.com")
    );
  });

  test("reports empty for files without bookmarks", () => {
    expect(Bookmarks.importBackup("<p>hello world</p>", HamHome)).toMatchObject({
      ok: false,
      reason: "empty",
    });
    expect(Bookmarks.importBackup('{"bookmarks":[]}', HamHome)).toMatchObject({
      ok: false,
      reason: "empty",
    });
  });

  test("reports invalid for broken JSON", () => {
    expect(Bookmarks.importBackup("{oops", HamHome)).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(Bookmarks.importBackup('{"nope":1}', HamHome)).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });
});

describe("extension/hamhome.js object input (issue #65)", () => {
  test("importFrom accepts already-parsed meta and categories", () => {
    const res = HamHome.importFrom(
      {
        bookmarks: [{ title: "A", url: "https://a.com/", categoryId: "c1" }],
      },
      { categories: [{ id: "c1", name: "Docs", parentId: "" }] }
    );
    expect(res.ok).toBe(true);
    expect(res.model.bookmarks[0]).toMatchObject({ url: "https://a.com/", folder: "Docs" });
  });
});
