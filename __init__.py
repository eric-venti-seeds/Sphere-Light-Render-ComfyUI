import torch
import numpy as np
from PIL import Image, ImageOps
import io, base64, os, hashlib
import folder_paths

# Guards for decoding the base64 image, which arrives via the (serialized,
# therefore untrusted) workflow. These bound how much work a malicious or
# malformed workflow can make the server do before the try/except catches it.
MAX_B64_CHARS  = 16 * 1024 * 1024   # a legit 1024^2 PNG data-URI is well under this
MAX_IMAGE_SIDE = 2048               # the browser renders 512^2; anything larger is a decompression bomb
TARGET_SIZE    = 1024
FALLBACK_GRAY  = (138, 138, 138)    # matches the JS clear color 0x8a8a8a

def decode_render_b64(render_b64):
    """Decode a data-URI PNG from the (untrusted) workflow into a
    (1,1024,1024,3) float32 tensor. Empty/invalid/oversized -> gray fallback."""
    img = None
    if render_b64 and render_b64.startswith("data:image"):
        if len(render_b64) > MAX_B64_CHARS:
            print(f"[SphereLight] render_b64 too large "
                  f"({len(render_b64)} chars); using gray fallback")
        else:
            try:
                header, data = render_b64.split(",", 1)
                img_bytes = base64.b64decode(data, validate=True)
                probe = Image.open(io.BytesIO(img_bytes))
                w, h = probe.size
                if w > MAX_IMAGE_SIDE or h > MAX_IMAGE_SIDE:
                    raise ValueError(f"image dimensions too large: {w}x{h}")
                img = probe.convert("RGB").resize(
                    (TARGET_SIZE, TARGET_SIZE), Image.LANCZOS)
            except Exception as e:
                print(f"[SphereLight] Error decoding render_b64: {e}")
                img = None
    else:
        print("[SphereLight] no render_b64 provided; using gray fallback")

    if img is None:
        img = Image.new("RGB", (TARGET_SIZE, TARGET_SIZE), FALLBACK_GRAY)

    arr = np.array(img).astype(np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


class SphereLightManualNode:
    DESCRIPTION = ("Renders a lit reference sphere for the Sun-Direction LoRA. "
                   "Set the light direction manually with rotation/elevation.")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "rotation":  ("FLOAT", {"default": 0.0,  "min": -180, "max": 180, "step": 1,   "display": "slider",
                                        "tooltip": "Light azimuth around the sphere, in degrees."}),
                "elevation": ("FLOAT", {"default": 45.0, "min": 5,    "max": 85,  "step": 1,   "display": "slider",
                                        "tooltip": "Light height above the horizon, in degrees."}),
                "intensity": ("FLOAT", {"default": 1.5,  "min": 0.2,  "max": 3.0, "step": 0.1, "display": "slider",
                                        "tooltip": "Light strength."}),
                "render_b64": ("STRING", {"default": "", "multiline": False,
                                          "tooltip": "Internal: the browser-rendered sphere image (managed automatically)."}),
            }
        }
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("render",)
    FUNCTION = "execute"
    CATEGORY = "render/3d"
    OUTPUT_NODE = False

    def execute(self, rotation, elevation, intensity, render_b64):
        # rotation/elevation/intensity are consumed client-side (js/nodes.js);
        # when connected upstream, the browser reads the driven value and bakes
        # it into render_b64 before the run. The server only needs render_b64.
        return (decode_render_b64(render_b64),)


class SphereLightSunCityNode:
    DESCRIPTION = ("Renders a lit reference sphere for the Sun-Direction LoRA. "
                   "The light follows the real sun for a city + date/time; "
                   "heading turns the camera (compass shown on the render).")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "intensity": ("FLOAT", {"default": 1.5, "min": 0.2, "max": 3.0, "step": 0.1, "display": "slider",
                                        "tooltip": "Light strength."}),
                "city":      ("STRING", {"default": "Austin, TX", "multiline": False,
                                         "tooltip": "City name, optionally with region/country (e.g. 'Austin, TX', 'London, UK')."}),
                "year":      ("INT", {"default": 2025, "min": 1, "max": 9999}),
                "month":     ("INT", {"default": 6,  "min": 1,  "max": 12}),
                "day":       ("INT", {"default": 21, "min": 1,  "max": 31}),
                "hour":      ("INT", {"default": 12, "min": 0,  "max": 23,
                                      "tooltip": "Local time at the chosen city (DST handled automatically)."}),
                "minute":    ("INT", {"default": 0,  "min": 0,  "max": 59}),
                "heading":   ("FLOAT", {"default": 0.0, "min": 0, "max": 360, "step": 0.01, "display": "slider",
                                        "tooltip": "Camera facing, degrees clockwise from North (matches EXIF GPSImgDirection)."}),
                "render_b64": ("STRING", {"default": "", "multiline": False,
                                          "tooltip": "Internal: the browser-rendered sphere image (managed automatically)."}),
            }
        }
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("render",)
    FUNCTION = "execute"
    CATEGORY = "render/3d"
    OUTPUT_NODE = False

    def execute(self, intensity, city, year, month, day, hour, minute, heading, render_b64):
        # city/heading and the date/time are consumed client-side (js/nodes.js),
        # and read from an upstream connection when driven. The server only needs
        # render_b64 (the browser bakes the resolved values into it at queue time).
        return (decode_render_b64(render_b64),)


class SphereLightSunCoordsNode:
    DESCRIPTION = ("Renders a lit reference sphere for the Sun-Direction LoRA. "
                   "The light follows the real sun for a latitude/longitude + "
                   "date/time; heading turns the camera (compass shown on the render).")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "intensity": ("FLOAT", {"default": 1.5, "min": 0.2, "max": 3.0, "step": 0.1, "display": "slider",
                                        "tooltip": "Light strength."}),
                "latitude":  ("FLOAT", {"default": 0.0, "min": -90.0,  "max": 90.0,  "step": 0.0001,
                                        "tooltip": "Degrees north (negative = south)."}),
                "longitude": ("FLOAT", {"default": 0.0, "min": -180.0, "max": 180.0, "step": 0.0001,
                                        "tooltip": "Degrees east (negative = west)."}),
                "year":      ("INT", {"default": 2025, "min": 1, "max": 9999}),
                "month":     ("INT", {"default": 6,  "min": 1,  "max": 12}),
                "day":       ("INT", {"default": 21, "min": 1,  "max": 31}),
                "hour":      ("INT", {"default": 12, "min": 0,  "max": 23,
                                      "tooltip": "Local time at the location (timezone borrowed from the nearest listed city)."}),
                "minute":    ("INT", {"default": 0,  "min": 0,  "max": 59}),
                "heading":   ("FLOAT", {"default": 0.0, "min": 0, "max": 360, "step": 0.01, "display": "slider",
                                        "tooltip": "Camera facing, degrees clockwise from North (matches EXIF GPSImgDirection)."}),
                "render_b64": ("STRING", {"default": "", "multiline": False,
                                          "tooltip": "Internal: the browser-rendered sphere image (managed automatically)."}),
            }
        }
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("render",)
    FUNCTION = "execute"
    CATEGORY = "render/3d"
    OUTPUT_NODE = False

    def execute(self, intensity, latitude, longitude, year, month, day, hour, minute, heading, render_b64):
        # All positioning params are consumed client-side (js/nodes.js), and read
        # from an upstream connection when driven. The server only needs
        # render_b64 (the browser bakes the resolved values into it at queue time).
        return (decode_render_b64(render_b64),)


class SphereLightPhotoExifNode:
    DESCRIPTION = ("Loads a photo and reads its EXIF in the browser: GPS "
                   "position, nearest city, compass heading (GPSImgDirection), "
                   "and capture date/time come out as outputs to wire into the "
                   "Sun nodes; the photo itself comes out as IMAGE.")

    @classmethod
    def INPUT_TYPES(cls):
        input_dir = folder_paths.get_input_directory()
        files = [f for f in os.listdir(input_dir)
                 if os.path.isfile(os.path.join(input_dir, f))]
        files = folder_paths.filter_files_content_types(files, ["image"])
        return {
            "required": {
                "image": (sorted(files), {"image_upload": True,
                          "tooltip": "The photo whose EXIF supplies the values below."}),
                # The browser (js/nodes.js) parses the photo's EXIF and writes
                # the results into these widgets before the run. Their names
                # must exactly match the Sun nodes' input names — the client
                # resolves a connection by identical widget name (see
                # connectedInputValue in js/nodes.js). Hand-editable so a photo
                # missing a tag can be corrected on the node.
                "latitude":  ("FLOAT", {"default": 0.0, "min": -90.0, "max": 90.0, "step": 0.0001,
                                        "tooltip": "From EXIF GPS; degrees north (negative = south)."}),
                "longitude": ("FLOAT", {"default": 0.0, "min": -180.0, "max": 180.0, "step": 0.0001,
                                        "tooltip": "From EXIF GPS; degrees east (negative = west)."}),
                "city":      ("STRING", {"default": "", "multiline": False,
                                         "tooltip": "Nearest listed city to the photo's GPS position."}),
                "year":      ("INT", {"default": 2025, "min": 1, "max": 9999}),
                "month":     ("INT", {"default": 6,  "min": 1,  "max": 12}),
                "day":       ("INT", {"default": 21, "min": 1,  "max": 31}),
                "hour":      ("INT", {"default": 12, "min": 0,  "max": 23}),
                "minute":    ("INT", {"default": 0,  "min": 0,  "max": 59}),
                # heading is deliberately LAST — it is also the last input on
                # the Sun nodes, so parallel wires don't cross.
                "heading":   ("FLOAT", {"default": 0.0, "min": 0, "max": 360, "step": 0.01,
                                        "tooltip": "From EXIF GPSImgDirection; degrees clockwise from North."}),
            }
        }

    RETURN_TYPES = ("IMAGE", "FLOAT", "FLOAT", "STRING",
                    "INT", "INT", "INT", "INT", "INT", "FLOAT")
    RETURN_NAMES = ("image", "latitude", "longitude", "city",
                    "year", "month", "day", "hour", "minute", "heading")
    FUNCTION = "execute"
    CATEGORY = "render/3d"
    OUTPUT_NODE = False

    def execute(self, image, latitude, longitude, city,
                year, month, day, hour, minute, heading):
        # The nine values are pass-throughs: the browser parsed the EXIF and
        # baked them into the widgets at edit time (same pattern as render_b64
        # on the sphere nodes), so they are already in the serialized prompt.
        path = folder_paths.get_annotated_filepath(image)
        img = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
        arr = np.array(img).astype(np.float32) / 255.0
        tensor = torch.from_numpy(arr).unsqueeze(0)
        return (tensor, latitude, longitude, city,
                year, month, day, hour, minute, heading)

    @classmethod
    def IS_CHANGED(cls, image, **kwargs):
        path = folder_paths.get_annotated_filepath(image)
        m = hashlib.sha256()
        with open(path, "rb") as f:
            m.update(f.read())
        return m.digest().hex()

    @classmethod
    def VALIDATE_INPUTS(cls, image):
        if not folder_paths.exists_annotated_filepath(image):
            return f"Invalid image file: {image}"
        return True


NODE_CLASS_MAPPINGS = {
    "SphereLightManualNode": SphereLightManualNode,
    "SphereLightSunCityNode": SphereLightSunCityNode,
    "SphereLightSunCoordsNode": SphereLightSunCoordsNode,
    "SphereLightPhotoExifNode": SphereLightPhotoExifNode,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "SphereLightManualNode": "🔆 Sphere Light — Manual",
    "SphereLightSunCityNode": "🔆 Sphere Light — Sun (City)",
    "SphereLightSunCoordsNode": "🔆 Sphere Light — Sun (Coordinates)",
    "SphereLightPhotoExifNode": "📷 Sphere Light — Photo (EXIF)",
}
WEB_DIRECTORY = "./js"
