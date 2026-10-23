#!/usr/bin/env python3
"""Read a Mach-O 64 object file's symbol table and report pulse::detail symbol resolution.

Neither GNU nm (`file format not recognized`) nor `python3 -m ziglang nm` (no such subcommand) can
inspect a Mach-O aarch64 object here, and zig's `c++ -shared` driver segfaults (rc=139) before it can
link one, so the usual "did it link" proof is not available. This parses LC_SYMTAB directly instead.

It answers the question VAL-AUDIO-002 actually asks: every `pulse::detail::*` symbol that
pulse_audio.o needs must be DEFINED EXTERNAL by coreaudio_impl.o.

That distinction is not academic. Wrapping a definition in an anonymous namespace does not merely
change its linkage — it changes its MANGLED NAME, which gains a `_GLOBAL__N_1` discriminator. So the
declaring file references `pulse::detail::pickDevice` while the defining file provides
`pulse::detail::(anonymous namespace)::pickDevice`: two unrelated symbols. Each translation unit
compiles cleanly on its own and the addon then fails to link. Per-translation-unit compilation can
never catch that, which is why this check exists separately from the compile step.

Usage: macho-symbols.py <object-file> [...]
Prints, per file, the defined-external and undefined symbols whose demangled name mentions
pulse::detail, then a resolution verdict when exactly two files are given.
"""
import struct
import subprocess
import sys

MH_MAGIC_64 = 0xFEEDFACF
MH_CIGAM_64 = 0xCFFAEDFE
LC_SYMTAB = 0x2
N_EXT = 0x01
N_TYPE = 0x0E
N_UNDF = 0x0
N_SECT = 0xE


def read_symbols(path):
    """Return (defined_external, defined_local, undefined) lists of symbol names."""
    blob = open(path, 'rb').read()
    magic = struct.unpack_from('<I', blob, 0)[0]
    if magic == MH_MAGIC_64:
        endian = '<'
    elif magic == MH_CIGAM_64:
        endian = '>'
    else:
        raise SystemExit(f'{path}: not a Mach-O 64 object (magic {magic:#x})')

    ncmds = struct.unpack_from(endian + 'I', blob, 16)[0]
    off = 32
    symtab = None
    for _ in range(ncmds):
        cmd, cmdsize = struct.unpack_from(endian + 'II', blob, off)
        if cmd == LC_SYMTAB:
            symoff, nsyms, stroff, strsize = struct.unpack_from(endian + 'IIII', blob, off + 8)
            symtab = (symoff, nsyms, stroff, strsize)
            break
        off += cmdsize
    if not symtab:
        raise SystemExit(f'{path}: no LC_SYMTAB')

    symoff, nsyms, stroff, _ = symtab
    defined_ext, defined_loc, undefined = [], [], []
    for i in range(nsyms):
        base = symoff + i * 16
        n_strx, n_type, _n_sect, _n_desc, _n_value = struct.unpack_from(endian + 'IBBHQ', blob, base)
        end = blob.index(b'\0', stroff + n_strx)
        name = blob[stroff + n_strx:end].decode('utf-8', 'replace')
        if not name:
            continue
        if (n_type & N_TYPE) == N_UNDF:
            undefined.append(name)
        elif (n_type & N_TYPE) == N_SECT:
            (defined_ext if (n_type & N_EXT) else defined_loc).append(name)
    return defined_ext, defined_loc, undefined


def demangle(names):
    if not names:
        return {}
    try:
        out = subprocess.run(['c++filt'], input='\n'.join(names), capture_output=True,
                             text=True, timeout=60)
        pretty = out.stdout.split('\n')
        if len(pretty) == len(names):
            return dict(zip(names, pretty))
    except Exception:
        pass
    return {n: n for n in names}


def interesting(names):
    """Keep only symbols that mention pulse::detail, mangled or demangled."""
    pretty = demangle(names)
    return [(n, pretty.get(n, n)) for n in names
            if 'pulse' in n and 'detail' in (n + pretty.get(n, n))]


def main():
    paths = sys.argv[1:]
    if not paths:
        raise SystemExit(__doc__)
    tables = {}
    for p in paths:
        de, dl, un = read_symbols(p)
        tables[p] = (de, dl, un)
        print(f'=== {p} ===')
        print(f'  symbols: {len(de)} defined-external, {len(dl)} defined-local, {len(un)} undefined')
        for label, names in (('DEFINED EXTERNAL', de), ('DEFINED LOCAL', dl), ('UNDEFINED', un)):
            hits = interesting(names)
            if not hits:
                continue
            print(f'  --- pulse::detail {label} ({len(hits)}) ---')
            for mangled, human in sorted(hits, key=lambda x: x[1]):
                short = human.replace('pulse::detail::', '')
                anon = 'ANONYMOUS-NAMESPACE' if '_GLOBAL__N_' in mangled or 'anonymous namespace' in human else ''
                print(f'    {short[:88]}{"  [" + anon + "]" if anon else ""}')
        print()

    if len(paths) == 2:
        consumer, provider = paths
        c_de, c_dl, c_un = tables[consumer]
        p_de, p_dl, p_un = tables[provider]
        need = [n for _, n in interesting(c_un)]
        have_ext = set(p_de)
        have_loc = set(p_dl)
        print('=== resolution verdict ===')
        if not need:
            print('  consumer references no pulse::detail symbol; nothing to resolve')
            return 0
        bad = 0
        for sym in sorted(set(need)):
            human = demangle([sym]).get(sym, sym).replace('pulse::detail::', '')
            if sym in have_ext:
                print(f'  RESOLVED     {human[:80]}')
            elif sym in have_loc:
                print(f'  LOCAL-ONLY   {human[:80]}  <- internal linkage, would NOT link')
                bad += 1
            else:
                # An anonymous-namespace definition has a DIFFERENT mangled name, so it shows up as
                # neither. Look for a near-miss to say which of the two failures this is.
                near = [n for n in have_ext | have_loc if '_GLOBAL__N_' in n
                        and sym.rsplit('E', 1)[-1] and n.endswith(sym.rsplit('E', 1)[-1])]
                if near:
                    print(f'  NAME-MISMATCH {human[:78]}  <- provider has an anonymous-namespace variant')
                else:
                    print(f'  UNDEFINED    {human[:80]}  <- not provided at all')
                bad += 1
        print()
        if bad:
            print(f'SYMBOL RESOLUTION FAILED: {bad} pulse::detail symbol(s) unresolved')
            return 1
        print(f'SYMBOL RESOLUTION OK: all {len(set(need))} pulse::detail symbol(s) the consumer '
              'needs are defined external by the provider')
    return 0


if __name__ == '__main__':
    sys.exit(main())
