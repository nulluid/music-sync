"""JSPF playlist format, extended with a music.smathe.rs namespace block.

See SPEC.md for the on-disk shape and why ISRC is the primary match key.
"""

from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel, Field

NS = "https://music.smathe.rs/ns#"

SERVICES = ("spotify", "ytmusic", "amazon")


class ServiceIds(BaseModel):
    spotify: str | None = None
    ytmusic: str | None = None
    amazon: str | None = None

    def get(self, service: str) -> str | None:
        return getattr(self, service)

    def set(self, service: str, value: str | None) -> None:
        setattr(self, service, value)


class Track(BaseModel):
    title: str
    creator: str  # artist
    album: str | None = None
    duration: int | None = None  # milliseconds
    track_num: int | None = Field(default=None, alias="trackNum")
    identifier: list[str] = Field(default_factory=list)
    isrc: str | None = None
    service_ids: ServiceIds = Field(default_factory=ServiceIds)

    model_config = {"populate_by_name": True}

    def to_jspf(self) -> dict:
        ext = {"isrc": self.isrc} if self.isrc else {}
        for service in SERVICES:
            value = self.service_ids.get(service)
            if value:
                ext[service] = {"id": value}
        out: dict = {"title": self.title, "creator": self.creator}
        if self.album:
            out["album"] = self.album
        if self.duration is not None:
            out["duration"] = self.duration
        if self.track_num is not None:
            out["trackNum"] = self.track_num
        if self.identifier:
            out["identifier"] = self.identifier
        if ext:
            out["extension"] = {NS: ext}
        return out

    @classmethod
    def from_jspf(cls, data: dict) -> "Track":
        ext = data.get("extension", {}).get(NS, {})
        service_ids = ServiceIds(
            **{
                service: ext[service]["id"]
                for service in SERVICES
                if service in ext and ext[service].get("id")
            }
        )
        return cls(
            title=data["title"],
            creator=data.get("creator", ""),
            album=data.get("album"),
            duration=data.get("duration"),
            trackNum=data.get("trackNum"),
            identifier=data.get("identifier", []),
            isrc=ext.get("isrc"),
            service_ids=service_ids,
        )


class Playlist(BaseModel):
    title: str
    creator: str | None = None
    annotation: str | None = None
    date: str | None = None
    source_of_truth: str | None = None
    playlist_ids: ServiceIds = Field(default_factory=ServiceIds)
    tracks: list[Track] = Field(default_factory=list)

    def to_jspf(self) -> dict:
        ext: dict = {}
        if self.source_of_truth:
            ext["sourceOfTruth"] = self.source_of_truth
        service_ids = {
            service: self.playlist_ids.get(service)
            for service in SERVICES
            if self.playlist_ids.get(service)
        }
        if service_ids:
            ext["serviceIds"] = service_ids
        playlist: dict = {"title": self.title}
        if self.creator:
            playlist["creator"] = self.creator
        if self.annotation:
            playlist["annotation"] = self.annotation
        if self.date:
            playlist["date"] = self.date
        if ext:
            playlist["extension"] = {NS: ext}
        playlist["track"] = [t.to_jspf() for t in self.tracks]
        return {"playlist": playlist}

    @classmethod
    def from_jspf(cls, data: dict) -> "Playlist":
        playlist = data["playlist"]
        ext = playlist.get("extension", {}).get(NS, {})
        service_ids_raw = ext.get("serviceIds", {})
        return cls(
            title=playlist["title"],
            creator=playlist.get("creator"),
            annotation=playlist.get("annotation"),
            date=playlist.get("date"),
            source_of_truth=ext.get("sourceOfTruth"),
            playlist_ids=ServiceIds(**service_ids_raw),
            tracks=[Track.from_jspf(t) for t in playlist.get("track", [])],
        )

    def save(self, path: str | Path) -> None:
        Path(path).write_text(json.dumps(self.to_jspf(), indent=2) + "\n")

    @classmethod
    def load(cls, path: str | Path) -> "Playlist":
        return cls.from_jspf(json.loads(Path(path).read_text()))
