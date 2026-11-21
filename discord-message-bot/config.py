import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv


def snowflake(value: str) -> int:
    if not re.fullmatch(r"[0-9]{17,20}", value) or not 0 < int(value) < 2**64:
        raise ValueError("Enter a valid Discord ID.")
    return int(value)


@dataclass(frozen=True)
class Config:
    token: str = field(repr=False)
    owner_id: int
    owner_ids: frozenset[int]
    guild_id: int | None

    @classmethod
    def load(cls) -> "Config":
        load_dotenv(Path(__file__).with_name(".env"))
        token = os.getenv("DISCORD_TOKEN", "").strip()
        if not token:
            raise ValueError("Set DISCORD_TOKEN in .env or in your hosting variables.")
        owner_value = os.getenv("OWNER_IDS", "").strip() or os.getenv("OWNER_ID", "").strip()
        if not owner_value:
            raise ValueError("Set OWNER_IDS or OWNER_ID in .env or in your hosting variables.")
        try:
            owner_ids = frozenset(snowflake(part.strip()) for part in owner_value.split(",") if part.strip())
        except ValueError:
            raise ValueError("Set OWNER_IDS to comma-separated valid Discord user IDs.") from None
        if not owner_ids:
            raise ValueError("Set OWNER_IDS to at least one Discord user ID.")
        guild_value = os.getenv("GUILD_ID", "").strip()
        try:
            guild_id = snowflake(guild_value) if guild_value else None
        except ValueError:
            raise ValueError("Set GUILD_ID to a valid Discord ID.") from None
        return cls(token, min(owner_ids), owner_ids, guild_id)
