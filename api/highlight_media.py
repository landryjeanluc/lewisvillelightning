"""Validate and remux locally uploaded MP4 clips for browser playback."""
from pathlib import Path

# Load Python's linked zlib before PyAV's manylinux FFmpeg libraries. NixOS
# keeps libz outside the global loader path; Python already knows its location.
import zlib  # noqa: F401
import av

MAX_BYTES = 100 * 1024 * 1024
CHUNK_BYTES = 8 * 1024 * 1024
MAX_SECONDS = 180


def prepare_clip(source: Path, destination: Path, poster: Path):
    # Force the MP4 demuxer and disallow external data references. The original
    # is never served; only selected audio/video streams enter the final file.
    options = {"enable_drefs": "0", "use_absolute_path": "0", "protocol_whitelist": "file"}
    try:
        with source.open("rb") as raw, av.open(raw, format="mov", options=options) as incoming:
            videos = list(incoming.streams.video)
            if len(videos) != 1:
                raise ValueError("Choose an MP4 clip with one video track.")
            video = videos[0]
            codec = video.codec_context
            if codec.name != "h264" or codec.format.name != "yuv420p":
                raise ValueError("Export the clip as MP4 using H.264, 8-bit colour.")
            if not (0 < codec.width <= 3840 and 0 < codec.height <= 3840):
                raise ValueError("Export the clip at 4K resolution or smaller.")
            duration = float(video.duration * video.time_base) if video.duration else 0
            if not 0 < duration <= MAX_SECONDS:
                raise ValueError("Choose a highlight no longer than 3 minutes.")
            audio = list(incoming.streams.audio)[:1]
            if audio and audio[0].codec_context.name != "aac":
                raise ValueError("Export the MP4 with AAC audio, or without sound.")
            # Decode a frame to reject corrupt/empty video and supply a thumbnail.
            frame = next(incoming.decode(video), None)
            if frame is None:
                raise ValueError("This video could not be read. Export it again as MP4.")
            thumbnail = frame.to_image()
            thumbnail.thumbnail((960, 960))
            thumbnail.save(poster, "JPEG", quality=85)
            incoming.seek(0)
            tracks = [video, *audio]
            with av.open(str(destination), "w", format="mp4", options={"movflags": "+faststart"}) as outgoing:
                mapping = {}
                for stream in tracks:
                    target = outgoing.add_stream_from_template(stream)
                    target.metadata.clear()
                    mapping[stream.index] = target
                for packet in incoming.demux(tracks):
                    if packet.size:
                        packet.stream = mapping[packet.stream.index]
                        outgoing.mux(packet)
            if destination.stat().st_size > MAX_BYTES:
                raise ValueError("Export a smaller clip, up to 100 MB.")
            return {"duration": duration, "width": codec.width, "height": codec.height}
    except (av.FFmpegError, StopIteration, AttributeError) as exc:
        raise ValueError("This video could not be read. Export it as MP4 with H.264 video and AAC audio.") from exc


def write_chunk(path: Path, offset: int, data: bytes):
    with path.open("r+b" if path.exists() else "w+b") as output:
        output.seek(offset)
        output.write(data)
        output.truncate()


def same_chunk(path: Path, offset: int, data: bytes):
    if not path.exists():
        return False
    with path.open("rb") as source:
        source.seek(offset)
        return source.read(len(data)) == data
