"""Batch-convert the Slim Shooter Pack FBX clips to GLB.

Run headless so bpy.ops gets a clean context (the GUI socket choked on
mode_set in build_hierarchy):

    blender --background --python _convert.py

FBX 2020 (v7700) binaries — three's FBXLoader can't parse these, but Blender
can. We keep Mixamo bone orientation (automatic_bone_orientation=False) so the
exported rig's bone-local rest matches the character GLBs (also Mixamo), which
is what lets a clip retarget by bone name with no per-bone fixup.
"""
import bpy, os, glob

HERE = os.path.dirname(os.path.abspath(__file__))

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)

for fbx in sorted(glob.glob(os.path.join(HERE, "*.fbx"))):
    name = os.path.splitext(os.path.basename(fbx))[0]
    reset()
    bpy.ops.import_scene.fbx(filepath=fbx, automatic_bone_orientation=False)
    out = os.path.join(HERE, name + ".glb")
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format="GLB",
        export_animations=True,
        export_skins=True,
        export_yup=True,
    )
    print("CONVERTED", name, "actions=", len(bpy.data.actions))

print("DONE")
