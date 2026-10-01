from __future__ import annotations

import sys

import click

from music_sync.format import Playlist
from music_sync.services import REGISTRY, AuthRequired, get_service
from music_sync.sync import ServiceReport, download, sync, upload

SERVICE_NAMES = list(REGISTRY)


def _print_report(report: ServiceReport) -> None:
    verb = "created" if report.created_playlist else "updated"
    click.echo(f"  {report.service}: {verb} playlist {report.playlist_id}")
    for r in report.results:
        if r.status == "unmatched":
            click.echo(f"    ! no match for \"{r.track.title}\" by {r.track.creator}")
    if report.unmatched:
        click.echo(f"    {len(report.unmatched)}/{len(report.results)} tracks unmatched")


@click.group()
def cli():
    """Upload, sync, and back up playlists across Spotify, YouTube Music, and Amazon Music."""


@cli.command()
@click.argument("service", type=click.Choice(SERVICE_NAMES))
def auth(service: str):
    """Run the one-time interactive login for a service."""
    svc = get_service(service)
    if not hasattr(svc, "authenticate"):
        click.echo(f"{service} has no interactive auth step.")
        return
    svc.authenticate()
    click.echo(f"{service}: authenticated.")


@click.command()
@click.argument("file", type=click.Path(exists=True))
@click.option(
    "--to",
    "targets",
    required=True,
    help=f"comma-separated services to upload to: {','.join(SERVICE_NAMES)}",
)
def upload_cmd(file: str, targets: str):
    """Upload a local playlist file to one or more services."""
    playlist = Playlist.load(file)
    target_names = [t.strip() for t in targets.split(",")]
    click.echo(f'Uploading "{playlist.title}" ({len(playlist.tracks)} tracks)')
    for name in target_names:
        try:
            service = get_service(name)
            report = upload(playlist, service)
            playlist.playlist_ids.set(name, report.playlist_id)
            _print_report(report)
        except AuthRequired as e:
            click.echo(f"  {e.service}: not authenticated — {e.instructions}", err=True)
    playlist.save(file)


cli.add_command(upload_cmd, name="upload")


@click.command()
@click.argument("service", type=click.Choice(SERVICE_NAMES))
@click.argument("playlist_name")
@click.option("-o", "--output", required=True, type=click.Path())
def download_cmd(service: str, playlist_name: str, output: str):
    """Download a playlist from a service and save it in the local format."""
    svc = get_service(service)
    try:
        playlist_id = svc.find_playlist_by_name(playlist_name)
        if not playlist_id:
            click.echo(f'No playlist named "{playlist_name}" found on {service}.', err=True)
            sys.exit(1)
        playlist = download(svc, playlist_id, title=playlist_name)
        playlist.save(output)
        click.echo(f"Saved {len(playlist.tracks)} tracks to {output}")
    except AuthRequired as e:
        click.echo(f"{e.service}: not authenticated — {e.instructions}", err=True)
        sys.exit(1)


cli.add_command(download_cmd, name="download")


@click.command()
@click.option(
    "--source",
    required=True,
    help="source of truth, as service:playlist-name, e.g. spotify:Long Drives",
)
@click.option(
    "--to",
    "targets",
    required=True,
    help=f"comma-separated services to mirror onto: {','.join(SERVICE_NAMES)}",
)
@click.option("--backup/--no-backup", default=True, help="save the synced state to a local file")
def sync_cmd(source: str, targets: str, backup: bool):
    """Mirror a playlist from its source of truth onto one or more target services."""
    if ":" not in source:
        raise click.UsageError("--source must be service:playlist-name")
    source_name, playlist_name = source.split(":", 1)
    target_names = [t.strip() for t in targets.split(",")]

    try:
        source_service = get_service(source_name)
        source_id = source_service.find_playlist_by_name(playlist_name)
        if not source_id:
            click.echo(f'No playlist named "{playlist_name}" found on {source_name}.', err=True)
            sys.exit(1)
        target_services = [get_service(name) for name in target_names]
        canonical, reports = sync(source_service, source_id, target_services, title=playlist_name)
    except AuthRequired as e:
        click.echo(f"{e.service}: not authenticated — {e.instructions}", err=True)
        sys.exit(1)

    canonical.source_of_truth = source_name
    canonical.playlist_ids.set(source_name, source_id)
    click.echo(f'Synced "{playlist_name}" from {source_name} ({len(canonical.tracks)} tracks)')
    for report in reports:
        canonical.playlist_ids.set(report.service, report.playlist_id)
        _print_report(report)

    if backup:
        from music_sync import config

        path = config.DEFAULT_BACKUP_DIR / f"{playlist_name}.jspf.json"
        config.DEFAULT_BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        canonical.save(path)
        click.echo(f"Backup saved to {path}")


cli.add_command(sync_cmd, name="sync")


if __name__ == "__main__":
    cli()
