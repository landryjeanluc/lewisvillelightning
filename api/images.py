"""Decode bounded images in a worker; write fresh pixels without metadata."""
from io import BytesIO
from pathlib import Path
import warnings

from PIL import Image, ImageOps
from fastapi import HTTPException

MAX_PIXELS = 24_000_000


def write_image(raw: bytes, directory: Path, stem: str, longest: int):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(raw)) as original:
                if original.format not in {"JPEG", "PNG", "WEBP"}:
                    raise ValueError("unsupported image format")
                if original.width * original.height > MAX_PIXELS:
                    raise ValueError("image dimensions too large")
                original.load()
                img = ImageOps.exif_transpose(original).convert("RGB")
                img.thumbnail((longest, longest), Image.Resampling.LANCZOS)
                clean = Image.new("RGB", img.size)
                clean.paste(img)
        directory.mkdir(parents=True, exist_ok=True)
        jpg, webp = directory / f"{stem}.jpg", directory / f"{stem}.webp"
        try:
            clean.save(jpg, "JPEG", quality=84, optimize=True)
            clean.save(webp, "WEBP", quality=80, method=4)
        except Exception:
            jpg.unlink(missing_ok=True)
            webp.unlink(missing_ok=True)
            raise
        return {"path": f"/uploads/{stem}.jpg", "webp": f"/uploads/{stem}.webp",
                "width": clean.width, "height": clean.height, "bytes": jpg.stat().st_size}
    except (ValueError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise HTTPException(400, "use a readable JPEG, PNG or WebP image of at most 24 megapixels") from None
