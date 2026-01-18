import argparse
import struct
import sys


def write_frame(pcm_bytes: bytes) -> None:
    sys.stdout.buffer.write(struct.pack("<I", len(pcm_bytes)))
    if pcm_bytes:
        sys.stdout.buffer.write(pcm_bytes)
    sys.stdout.buffer.flush()


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--text", required=True)
    p.add_argument("--emotion", default="neutral")
    p.add_argument("--intensity", default="0.4")
    p.add_argument("--sample-rate", default="24000")
    p.add_argument("--chunk-ms", default="30")
    args = p.parse_args()

    text = args.text
    sr = int(float(args.sample_rate))
    chunk_ms = int(float(args.chunk_ms))

    try:
        # chatterbox-streaming must be installed in the conda env.
        from chatterbox_streaming import stream_tts  # type: ignore
    except Exception as e:
        sys.stderr.write(
            "chatterbox_streaming not available. Install with: pip install chatterbox-streaming\n"
        )
        sys.stderr.write(str(e) + "\n")
        return 2

    try:
        # stream_tts yields PCM16LE chunks (bytes)
        for pcm in stream_tts(
            text=text,
            sample_rate=sr,
            chunk_ms=chunk_ms,
            emotion=args.emotion,
            intensity=float(args.intensity),
        ):
            if not pcm:
                continue
            write_frame(pcm)

        # end marker
        write_frame(b"")
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception as e:
        sys.stderr.write(str(e) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
