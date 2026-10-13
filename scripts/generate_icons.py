import os
from PIL import Image, ImageDraw

def render_dubber_icon(size, mode='standard'):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    center = size / 2.0
    
    if mode == 'foreground':
        scale = 0.68
    else:
        scale = 0.88
        radius = size * 0.44
        bg_color = (15, 23, 42, 255) # Deep slate #0f172a
        if mode == 'round':
            draw.ellipse([center - radius, center - radius, center + radius, center + radius], fill=bg_color)
        else:
            corner_r = int(size * 0.22)
            draw.rounded_rectangle([center - radius, center - radius, center + radius, center + radius], radius=corner_r, fill=bg_color)

        border_r = radius * 0.96
        bw = max(1, int(size * 0.015))
        draw.ellipse([center - border_r, center - border_r, center + border_r, center + border_r], outline=(16, 185, 129, 90), width=bw)

    bar_w = max(2, int(size * 0.055 * scale))
    gap = max(1, int(size * 0.040 * scale))
    max_h = size * 0.50 * scale

    heights = [0.30, 0.60, 0.95, 0.65, 0.35]
    total_w = len(heights) * bar_w + (len(heights) - 1) * gap
    start_x = center - (total_w / 2.0)

    emerald = (16, 185, 129, 255)
    light_emerald = (52, 211, 153, 255)
    cyan = (6, 182, 212, 255)
    white = (255, 255, 255, 255)

    for i, h in enumerate(heights):
        bx = start_x + i * (bar_w + gap)
        bh = max(3, max_h * h)
        top_y = center - (bh / 2.0)
        bot_y = center + (bh / 2.0)
        r = max(1, int(bar_w / 2))
        
        if i == 2:
            c = white
        elif i in (1, 3):
            c = light_emerald
        else:
            c = cyan
            
        draw.rounded_rectangle([bx, top_y, bx + bar_w, bot_y], radius=r, fill=c)

    arc_r = size * 0.28 * scale
    arc_w = max(1, int(size * 0.022 * scale))
    draw.arc([center - arc_r - gap, center - arc_r, center + arc_r - gap, center + arc_r], start=130, end=230, fill=cyan, width=arc_w)
    draw.arc([center - arc_r + gap, center - arc_r, center + arc_r + gap, center + arc_r], start=-50, end=50, fill=emerald, width=arc_w)

    return img

densities = {
    'mipmap-mdpi': {'legacy': 48, 'fg': 108},
    'mipmap-hdpi': {'legacy': 72, 'fg': 162},
    'mipmap-xhdpi': {'legacy': 96, 'fg': 216},
    'mipmap-xxhdpi': {'legacy': 144, 'fg': 324},
    'mipmap-xxxhdpi': {'legacy': 192, 'fg': 432},
}

base_res = 'android/app/src/main/res'

for folder, sizes in densities.items():
    dir_path = os.path.join(base_res, folder)
    os.makedirs(dir_path, exist_ok=True)
    
    img_legacy = render_dubber_icon(sizes['legacy'], mode='standard')
    img_legacy.save(os.path.join(dir_path, 'ic_launcher.png'))
    
    img_round = render_dubber_icon(sizes['legacy'], mode='round')
    img_round.save(os.path.join(dir_path, 'ic_launcher_round.png'))
    
    img_fg = render_dubber_icon(sizes['fg'], mode='foreground')
    img_fg.save(os.path.join(dir_path, 'ic_launcher_foreground.png'))
    
    print(f"Generated icons for {folder}: legacy={sizes['legacy']}px, fg={sizes['fg']}px")

for target_dir in ['public', '.']:
    os.makedirs(target_dir, exist_ok=True)
    icon_512 = render_dubber_icon(512, mode='standard')
    icon_512.save(os.path.join(target_dir, 'icon-512.png'))
    icon_192 = render_dubber_icon(192, mode='standard')
    icon_192.save(os.path.join(target_dir, 'icon-192.png'))
    icon_favicon = render_dubber_icon(64, mode='round')
    icon_favicon.save(os.path.join(target_dir, 'favicon.png'))

print("All Android and Web branding assets generated!")
