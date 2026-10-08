const CONTENT_URL = "https://github.com/ramakrishnanhulk20/Moi/blob/main/packages/web/content/docs/";

/** The last line of every docs page. `path` is the file's path inside content/docs. */
export function EditLink({ path }: { path: string }) {
  return (
    <p className="docs-edit">
      <a className="docs-edit-link" href={`${CONTENT_URL}${path}`} target="_blank" rel="noreferrer noopener">
        Edit this page on GitHub
      </a>
    </p>
  );
}
