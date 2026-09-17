"use client";

export function IngestFileField() {
  return (
    <label className="grid gap-1 text-[12px] text-muted-foreground">
      Or upload a .txt / .md file
      <input
        type="file"
        accept=".txt,.md,text/plain"
        className="text-[12px] text-foreground file:mr-2 file:rounded-md file:border file:border-input file:bg-transparent file:px-2 file:py-1"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          const form = event.currentTarget.form;
          if (!file || !form) return;
          void file.text().then((text) => {
            const title = form.elements.namedItem("title");
            const body = form.elements.namedItem("text");
            if (title instanceof HTMLInputElement && !title.value) {
              title.value = file.name.replace(/\.[^.]+$/, "").replaceAll(/[_-]+/g, " ");
            }
            if (body instanceof HTMLTextAreaElement) {
              body.value = text;
            }
          });
        }}
      />
    </label>
  );
}
