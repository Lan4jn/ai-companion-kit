#!/usr/bin/python3
"""Read-only, point-in-time Linux migration diagnostics; never authorizes writes."""
import argparse
import json
import os
import stat
import sys
from pathlib import Path


def inspect(directory):
    d = Path(directory)
    if not d.is_absolute() or str(d) != os.path.realpath(d):
        raise ValueError('directory must be absolute and canonical')
    st = os.lstat(d)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise ValueError('unsafe directory')
    warnings = []
    files = []
    identities = {}
    # Capture all direct entries, not just the selected target. Never follow links.
    with os.scandir(d) as entries:
        for entry in entries:
            try:
                s = entry.stat(follow_symlinks=False)
                item = {'name': entry.name, 'device': s.st_dev, 'inode': s.st_ino,
                        'kind': 'file' if stat.S_ISREG(s.st_mode) else 'other',
                        'safe_private_file': bool(stat.S_ISREG(s.st_mode) and s.st_uid == os.getuid() and not s.st_mode & 0o077 and s.st_nlink == 1)}
                files.append(item)
                identities[(s.st_dev, s.st_ino)] = entry.name
                if not item['safe_private_file']:
                    warnings.append('unsafe or non-file entry: '+entry.name)
            except OSError as e:
                warnings.append('cannot stat entry: '+entry.name+' ('+str(e)+')')
    identities[(st.st_dev, st.st_ino)] = '.'
    opened = []
    mapped = []
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit() or int(proc.name) == os.getpid():
            continue
        try:
            descriptors = list((proc/'fd').iterdir())
        except FileNotFoundError:
            continue
        except OSError:
            warnings.append('cannot inspect process '+proc.name+' descriptors')
            continue
        for fd in descriptors:
            try:
                s = fd.stat()
                name = identities.get((s.st_dev, s.st_ino))
                if name is not None:
                    opened.append({'pid':int(proc.name), 'fd':fd.name, 'entry':name})
            except FileNotFoundError:
                pass
            except OSError:
                warnings.append('cannot inspect process '+proc.name+' fd '+fd.name)
        try:
            for line in (proc/'maps').read_text().splitlines():
                cols = line.split(None, 5)
                if len(cols) < 5 or not cols[4].isdigit():
                    continue
                major, minor = (int(x,16) for x in cols[3].split(':'))
                name = identities.get((os.makedev(major, minor), int(cols[4])))
                if name is not None:
                    mapped.append({'pid':int(proc.name), 'entry':name})
        except FileNotFoundError:
            pass
        except (OSError, ValueError):
            warnings.append('cannot inspect process '+proc.name+' mappings')
    locks = []
    try:
        for line in Path('/proc/locks').read_text().splitlines():
            parts = line.split()
            for i, part in enumerate(parts):
                bits = part.split(':')
                if len(bits) != 3:
                    continue
                try:
                    key = (os.makedev(int(bits[0],16),int(bits[1],16)),int(bits[2]))
                except ValueError:
                    continue
                if key in identities:
                    locks.append({'entry': identities[key], 'kernel_record': line})
                break
    except OSError as e:
        warnings.append('cannot inspect kernel locks: '+str(e))
    return {'authorizes_migration':False, 'directory':str(d), 'entries':sorted(files,key=lambda x:x['name']),
            'open_files':opened, 'mapped_files':mapped, 'sqlite_locks':locks,
            'inspection_warnings':warnings,
            'limitations':['Point-in-time observations are not a stop-write guarantee; processes may start or write immediately afterwards.',
                           'Only this host, PID namespace, visible /proc, and direct directory entries are inspected; remote hosts, other namespaces, hidden mounts, future files, hard-link aliases, open directories and revoked markers may be missed.',
                           'Advisory locks do not constrain unrelated writers; source databases and filesystem revocations have no atomic transaction with the target.',
                           'Inspect deployment topology, all workers, services, hosts, mount aliases and source/marker writers manually; an empty report or lack of warnings is not proof of quiescence.',
                           'Migration requires explicit human authorization and verified operational quiescence; resolve unknown outcomes manually and never retry automatically.']}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory',help='absolute canonical restricted migration directory')
    args=parser.parse_args()
    try:
        print(json.dumps(inspect(args.directory),ensure_ascii=False,indent=2))
    except (OSError, ValueError) as e:
        print('preflight refused: '+str(e),file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
