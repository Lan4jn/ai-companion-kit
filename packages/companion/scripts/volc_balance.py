#!/usr/bin/env python3
"""查火山引擎账户余额，输出一行 JSON 给 Node 侧解析。

签名用官方 SDK 的 SignerV4（手写版试过，火山这套 HMAC 有几个坑对不上）。
凭据读 /root/AccessKey.txt，格式 `AccessKeyId: xxx` / `SecretAccessKey: xxx`。
"""
import json
import re
import sys

AK_FILE = '/root/AccessKey.txt'


def main():
    try:
        t = open(AK_FILE).read()
        ak = re.search(r'AccessKeyId\s*[:=]\s*(\S+)', t).group(1)
        sk = re.search(r'SecretAccessKey\s*[:=]\s*(\S+)', t).group(1)
    except Exception as e:
        print(json.dumps({'error': 'no_credentials', 'detail': str(e)[:120]}))
        return 0

    try:
        from volcengine.auth.SignerV4 import SignerV4
        from volcengine.base.Request import Request
        from volcengine.Credentials import Credentials
        import urllib.request
    except Exception as e:
        print(json.dumps({'error': 'no_sdk', 'detail': str(e)[:120]}))
        return 0

    host, service, region = 'billing.volcengineapi.com', 'billing', 'cn-north-1'
    action, version = 'QueryBalanceAcct', '2022-01-01'

    try:
        req = Request()
        req.set_method('POST')
        req.set_schema('https')
        req.set_host(host)
        req.set_path('/')
        req.set_query({'Action': action, 'Version': version})
        req.set_headers({'Content-Type': 'application/json'})
        req.set_body(b'')
        SignerV4.sign(req, Credentials(ak, sk, service, region))

        url = f'https://{host}/?Action={action}&Version={version}'
        r = urllib.request.Request(url, data=b'', method='POST', headers=req.headers)
        with urllib.request.urlopen(r, timeout=20) as resp:
            d = json.loads(resp.read().decode())
        res = d.get('Result', {})
        print(json.dumps({
            'accountId': res.get('AccountID'),
            'available': float(res.get('AvailableBalance') or 0),
            'cash': float(res.get('CashBalance') or 0),
            'arrears': float(res.get('ArrearsBalance') or 0),
            'creditLimit': float(res.get('CreditLimit') or 0),
            'currency': res.get('Currency') or 'CNY',
        }))
    except Exception as e:
        print(json.dumps({'error': type(e).__name__, 'detail': str(e)[:160]}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
