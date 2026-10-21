"""Voice keeps its own toolbar and stage; it only takes the shared sidebar and shell helpers."""
import re
from shell import SIDEBAR, SHELL_JS

s = open('StageVoice.src.html').read()
a = s.index('<nav aria-label="Sidebar"')
b = s.index('</nav>', a) + len('</nav>')
s = s[:a] + SIDEBAR.strip() + s[b:]

s = s.replace("""    return {
      tc: this.props.theme === 'Dark' ? 'dk' : 'lt',""", """    return Object.assign(this.shellVals('Home'), {""")
s = re.sub(r",\n      nav: \[.*?\]\.map\(function \(n\) \{.*?\}\),\n      pinned: \[.*?\n      \]\n    \};", "\n    });", s, flags=re.S)
s = s.replace("  }\n}\n</script>", "  }\n" + SHELL_JS + "}\n</script>")
assert "shellVals('Home')" in s and 'nav: [' not in s.split('<script type="text/x-dc"')[1].split('shellVals(active)')[0], 'patch failed'
open('../StageVoice.dc.html', 'w').write(s)
print('wrote StageVoice')
