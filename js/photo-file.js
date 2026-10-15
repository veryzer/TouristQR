export const PHOTO_UPLOAD_MAX = 1_600_000;

export function photoInputAccept() {
  return "image/jpeg,image/png,image/gif,image/webp,.jpg,.jpeg,.png,.gif,.webp";
}

function kindFromFile(file) {
  const type = String(file.type || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();
  if (type === "image/gif" || name.endsWith(".gif")) return "gif";
  if (type === "image/png" || name.endsWith(".png")) return "png";
  if (type === "image/webp" || name.endsWith(".webp")) return "webp";
  if (type === "image/jpeg" || type === "image/jpg" || /\.jpe?g$/.test(name)) return "jpeg";
  return null;
}

export function preparePhotoFile(file) {
  const kind = kindFromFile(file);
  if (!kind) {
    return Promise.reject(new Error("Use JPEG, PNG, GIF, or WebP."));
  }
  if (/heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name || "")) {
    return Promise.reject(new Error("HEIC photos need to be JPEG or PNG first."));
  }
  if (kind === "gif") {
    if (file.size > PHOTO_UPLOAD_MAX) {
      return Promise.reject(new Error("That GIF is too large. Use one under about 1.5 MB."));
    }
    return Promise.resolve({ blob: file, contentType: "image/gif", ext: "gif" });
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, 1200 / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      const mime = kind === "png" ? "image/png" : kind === "webp" ? "image/webp" : "image/jpeg";
      const ext = kind === "png" ? "png" : kind === "webp" ? "webp" : "jpg";
      const quality = kind === "jpeg" ? 0.82 : undefined;
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url);
        if (!blob) reject(new Error("This photograph could not be resized."));
        else resolve({ blob, contentType: mime, ext });
      }, mime, quality);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("This file could not be opened as a photograph."));
    };
    image.src = url;
  });
}

/** Club / sponsor logos for the public action bar (small square thumbnail). */
export function prepareLogoFile(file, maxSize = 128) {
  return preparePhotoFile(file).then(({ blob, contentType, ext }) => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      const outExt = ext === "png" ? "png" : ext === "webp" ? "webp" : "jpg";
      canvas.toBlob((out) => {
        URL.revokeObjectURL(url);
        if (!out) reject(new Error("The logo could not be resized."));
        else resolve({ blob: out, contentType: mime, ext: outExt });
      }, mime, outExt === "jpg" ? 0.85 : undefined);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("This file could not be opened as an image."));
    };
    image.src = url;
  }));
}

export function extFromDataUrl(dataUrl) {
  const match = /^data:image\/(\w+);base64,/i.exec(String(dataUrl || "").trim());
  if (!match) return "jpg";
  const mime = match[1].toLowerCase();
  if (mime === "jpeg") return "jpg";
  if (mime === "png" || mime === "gif" || mime === "webp") return mime;
  return "jpg";
}
