import argparse
import os

import cv2
import numpy as np
import torch

from unwarp.utils import IMG_SIZE, bilinear_unwarping, load_model


def unwarp_img(model, device, img_path, img_size, out_path):
    """
    Unwarp a document image using the given model.
    """
    # Load image
    img = cv2.imread(img_path)
    if img is None:
        raise FileNotFoundError(f"Could not read image: {img_path}")
    img = cv2.flip(img, 1)  # mirror left-right before unwarping
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255
    inp = torch.from_numpy(cv2.resize(img, img_size).transpose(2, 0, 1)).unsqueeze(0)

    # Make prediction
    inp = inp.to(device)
    point_positions2D, _ = model(inp)

    # Unwarp
    size = img.shape[:2][::-1]
    unwarped = bilinear_unwarping(
        warped_img=torch.from_numpy(img.transpose(2, 0, 1)).unsqueeze(0).to(device),
        point_positions=torch.unsqueeze(point_positions2D[0], dim=0),
        img_size=tuple(size),
    )
    unwarped = (unwarped[0].detach().cpu().numpy().transpose(1, 2, 0) * 255).astype(np.uint8)

    # Save result
    unwarped_BGR = cv2.cvtColor(unwarped, cv2.COLOR_RGB2BGR)
    cv2.imwrite(out_path, unwarped_BGR)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--ckpt-path", type=str, default="weights/best_model.pkl", help="Path to the model weights as pkl."
    )
    parser.add_argument("--img-path", type=str, help="Path to the document image, or a folder of images, to unwarp.")
    parser.add_argument(
        "--out-path",
        type=str,
        help="Output file (or folder, if --img-path is a folder). Defaults to <image>_unwarp.png next to each input.",
    )

    args = parser.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = load_model(args.ckpt_path)
    model.to(device)
    model.eval()

    if os.path.isdir(args.img_path):
        names = sorted(
            f
            for f in os.listdir(args.img_path)
            if f.lower().endswith((".jpg", ".jpeg", ".png")) and not f.endswith("_unwarp.png")
        )
        out_dir = args.out_path or args.img_path
        os.makedirs(out_dir, exist_ok=True)
        for i, name in enumerate(names, 1):
            print(f"[{i}/{len(names)}] {name}")
            out_path = os.path.join(out_dir, os.path.splitext(name)[0] + "_unwarp.png")
            unwarp_img(model, device, os.path.join(args.img_path, name), IMG_SIZE, out_path)
    else:
        out_path = args.out_path or os.path.splitext(args.img_path)[0] + "_unwarp.png"
        unwarp_img(model, device, args.img_path, IMG_SIZE, out_path)
