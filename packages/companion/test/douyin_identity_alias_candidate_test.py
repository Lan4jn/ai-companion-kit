import importlib.util
import pathlib
import unittest
from types import SimpleNamespace
from unittest.mock import patch

PATH = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'douyin_identity_lease_candidate.py'
spec = importlib.util.spec_from_file_location('lease_alias_candidate', PATH)
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)

class IdentityAliasTest(unittest.TestCase):
    def test_rejects_another_nss_user_with_reserved_primary_gid(self):
        account = SimpleNamespace(pw_name='dyfixture61101', pw_uid=61101, pw_gid=61101,
                                  pw_dir='/nonexistent', pw_shell='/sbin/nologin')
        other = SimpleNamespace(pw_name='other', pw_uid=61102, pw_gid=61101)
        group = SimpleNamespace(gr_name='dyfixture61101', gr_gid=61101, gr_mem=[])
        with patch.object(candidate.pwd, 'getpwuid', return_value=account), \
             patch.object(candidate.pwd, 'getpwall', return_value=[account, other]), \
             patch.object(candidate.grp, 'getgrgid', return_value=group), \
             patch.object(candidate.grp, 'getgrall', return_value=[group]), \
             patch.object(candidate.pathlib.Path, 'iterdir', return_value=iter(())):
            with self.assertRaisesRegex(RuntimeError, 'identity.*conflict'):
                candidate._validate_identity(61101, 61101, 'dyfixture61101')

    def test_rejects_uid_alias_and_group_alias(self):
        account = SimpleNamespace(pw_name='dyfixture61101', pw_uid=61101, pw_gid=61101,
                                  pw_dir='/nonexistent', pw_shell='/sbin/nologin')
        group = SimpleNamespace(gr_name='dyfixture61101', gr_gid=61101, gr_mem=[])
        aliases = [
            ([account, SimpleNamespace(pw_name='other', pw_uid=61101, pw_gid=61102)], [group]),
            ([account], [group, SimpleNamespace(gr_name='other', gr_gid=61101, gr_mem=[])]),
        ]
        for users, groups in aliases:
            with self.subTest(users=users, groups=groups), \
                 patch.object(candidate.pwd, 'getpwuid', return_value=account), \
                 patch.object(candidate.pwd, 'getpwall', return_value=users), \
                 patch.object(candidate.grp, 'getgrgid', return_value=group), \
                 patch.object(candidate.grp, 'getgrall', return_value=groups), \
                 patch.object(candidate.pathlib.Path, 'iterdir', return_value=iter(())):
                with self.assertRaisesRegex(RuntimeError, 'identity.*conflict'):
                    candidate._validate_identity(61101, 61101, 'dyfixture61101')

if __name__ == '__main__': unittest.main()
