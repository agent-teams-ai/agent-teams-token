"""Emit exact analyzed inventory from the pinned Slither object model."""

import json

from slither.slither import Slither


analysis = Slither(
    ".",
    foundry_ignore_compile=True,
    foundry_out_directory="/work/out",
    foundry_build_info_directory="/work/out/build-info",
)
contracts = sorted({contract.name for contract in analysis.contracts})
sources = sorted(
    {
        str(contract.source_mapping.filename.relative).replace("\\", "/")
        for contract in analysis.contracts
    }
)
print(json.dumps({"success": True, "contracts": contracts, "sources": sources, "errors": []}))
