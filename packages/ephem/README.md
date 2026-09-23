# @ortho-earth/ephem

Solar-system ephemeris, a shared clock, and satellite propagation — zero dependencies, browser and Node.

- **Planets** — JPL approximate orbital elements (1800–2050), Schlyter's lunar theory, IAU rotation
- **Clock** (`./clock`) — one simulated time the whole scene follows: the night side, the stars and the
  satellites all draw *the same instant*
- **Sun** (`./sun`) — subsolar point, declination, equation of time
- **Satellites** (`./sgp4`) — SGP4/SDP4 from TLEs

```
npm i @ortho-earth/ephem
```

```js
import { bodyPos, byId, jd } from "@ortho-earth/ephem";        // 惑星・月の位置（AU・黄道座標）
import { createClock } from "@ortho-earth/ephem/clock";        // みんなが従う「その時刻」
import { satPos, satById } from "@ortho-earth/ephem/sgp4";     // 人工衛星（TLE → 位置）
```

> Published as `@ortho-earth/ephem` because the bare name `ephem` on npm belongs to an unrelated package.

## License

GPL-3.0-or-later ([LICENSE](LICENSE)). A commercial license — without GPL obligations such as disclosing
your site's source — is available: contact kenji.yoshida.home.2026@gmail.com.
