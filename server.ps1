# Aurora Watch Lite: the watchlist server using only what ships with Windows.
# Keep this file ASCII: Windows PowerShell 5.1 misreads UTF-8 scripts without a BOM.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Net.Http

$BaseDir = $PSScriptRoot
$WebDir = Join-Path $BaseDir 'web'
$ConfigPath = if ($env:WATCHLIST_FILE) { $env:WATCHLIST_FILE } else { Join-Path $BaseDir 'watchlist.json' }
$ChartUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/{0}?range=5d&interval=1m&includePrePost=true'
$SearchUrl = 'https://query1.finance.yahoo.com/v1/finance/search?q={0}&quotesCount=6&newsCount=0&listsCount=0'
$TickerRe = '^\^?[A-Z0-9][A-Z0-9.\-=]{0,14}$'
$CacheTtl = 10        # seconds a quote is served before Yahoo is asked again
$MaxChartPoints = 260
$Indexes = @('SPY', 'QQQ', 'DIA')
$StaticFiles = @{
    '/'           = @('index.html', 'text/html; charset=utf-8')
    '/app.js'     = @('app.js', 'text/javascript; charset=utf-8')
    '/style.css'  = @('style.css', 'text/css; charset=utf-8')
}

$Client = New-Object System.Net.Http.HttpClient
$Client.Timeout = [TimeSpan]::FromSeconds(10)
[void]$Client.DefaultRequestHeaders.TryAddWithoutValidation('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AuroraWatch/1.0')

$Cache = @{}   # symbol -> @{ At = seconds; Json = quote as JSON text }

function Get-Now { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 1000.0 }

function ConvertTo-Ticker($Value) {
    if ($null -eq $Value) { return $null }
    $symbol = ([string]$Value).Trim().ToUpperInvariant()
    if ($symbol -cmatch $TickerRe) { return $symbol }
    return $null
}

# ------------------------------------------------------------- config file
function Get-Tickers {
    if (-not (Test-Path -LiteralPath $ConfigPath)) { return @() }
    try {
        $data = [IO.File]::ReadAllText($ConfigPath) | ConvertFrom-Json
        # PowerShell 7 unrolls JSON lists, so [] arrives as null and ["A"] as a string.
        $raw = if ($null -eq $data -or $data -is [array] -or $data -is [string]) { $data } elseif ($data.PSObject.Properties['tickers']) { $data.tickers } else { throw 'no tickers key' }
        $seen = @{}
        $clean = foreach ($t in @($raw)) {
            $symbol = ConvertTo-Ticker $t
            if ($symbol -and -not $seen[$symbol]) { $seen[$symbol] = $true; $symbol }
        }
        return @($clean)
    } catch {
        # Keep the unreadable file so a hand edit gone wrong can be recovered.
        $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        $backup = [IO.Path]::ChangeExtension($ConfigPath, ".corrupt-$stamp.json")
        Move-Item -LiteralPath $ConfigPath -Destination $backup
        Write-Warning "Unreadable config; moved it to $backup"
        return @()
    }
}

function Save-Tickers($Tickers) {
    $tmp = "$ConfigPath.tmp"
    $body = ConvertTo-Json @{ tickers = @($Tickers) } -Depth 3
    [IO.File]::WriteAllText($tmp, $body + "`n")
    Move-Item -LiteralPath $tmp -Destination $ConfigPath -Force
}

# ------------------------------------------------------------- quote logic
function Get-TradingDays($Meta) {
    $periods = $Meta.tradingPeriods
    if ($null -eq $periods) { return @() }
    # 24h instruments return a bare list of regular periods
    if ($periods -is [array]) { $regular = $periods; $pres = @(); $posts = @() }
    else { $regular = @($periods.regular); $pres = @($periods.pre); $posts = @($periods.post) }
    $days = New-Object Collections.ArrayList
    for ($i = 0; $i -lt $regular.Count; $i++) {
        $entry = @($regular[$i])[0]
        $day = @{ regular = @($entry.start, $entry.end) }
        if ($i -lt $pres.Count) {
            $w = @($pres[$i])[0]
            if ($w.end -gt $w.start) { $day.pre = @($w.start, $w.end) }
        }
        if ($i -lt $posts.Count) {
            $w = @($posts[$i])[0]
            if ($w.end -gt $w.start) { $day.post = @($w.start, $w.end) }
        }
        [void]$days.Add($day)
    }
    return , $days.ToArray()
}

# Candle times are sorted, so windows are found by binary search rather than scanning.
function Get-LowerBound([long[]]$Times, [long]$Value) {
    $lo = 0; $hi = $Times.Length
    while ($lo -lt $hi) {
        $mid = [int][math]::Floor(($lo + $hi) / 2)
        if ($Times[$mid] -lt $Value) { $lo = $mid + 1 } else { $hi = $mid }
    }
    return $lo
}

function New-Move($Price, $Base, $When) {
    if ($null -eq $Price) { return $null }
    $change = if ($Base) { $Price - $Base } else { $null }
    return @{
        price  = $Price
        change = $change
        pct    = if ($Base) { $change / $Base * 100 } else { $null }
        base   = $Base
        time   = $When
    }
}

function Build-QuoteJson($Symbol, $Raw) {
    $meta = $Raw.meta
    $quote = @($Raw.indicators.quote)[0]
    $rawTimes = @($Raw.timestamp)
    $rawCloses = @($quote.close)
    $timeList = New-Object 'Collections.Generic.List[long]'
    $closeList = New-Object 'Collections.Generic.List[double]'
    for ($i = 0; $i -lt $rawTimes.Count -and $i -lt $rawCloses.Count; $i++) {
        if ($null -ne $rawCloses[$i] -and $null -ne $rawTimes[$i]) {
            $timeList.Add([long]$rawTimes[$i]); $closeList.Add([double]$rawCloses[$i])
        }
    }
    $times = $timeList.ToArray()
    $closes = $closeList.ToArray()

    $now = Get-Now
    $days = Get-TradingDays $meta
    $price = $meta.regularMarketPrice
    $marketTime = if ($meta.regularMarketTime) { $meta.regularMarketTime } else { 0 }
    $previousClose = if ($meta.previousClose) { $meta.previousClose } else { $meta.chartPreviousClose }

    # Index of the last candle in a window, or -1.
    function LastIn($Window) {
        if ($null -eq $Window) { return -1 }
        $idx = (Get-LowerBound $times ([long]$Window[1])) - 1
        if ($idx -ge 0 -and $times[$idx] -ge $Window[0]) { return $idx }
        return -1
    }
    function StartOf($Day) { if ($Day.pre) { $Day.pre[0] } else { $Day.regular[0] } }
    function EndOf($Day) { if ($Day.post) { $Day.post[1] } else { $Day.regular[1] } }

    $current = $null
    for ($i = 0; $i -lt $days.Count; $i++) {
        if ((StartOf $days[$i]) -le $now) { $current = $i }
    }

    # The last day whose regular session traded. Yahoo's headline price and previous
    # close describe that day, and are official closes rather than the last 1m candle.
    $lastRegular = $null
    for ($i = 0; $i -lt $days.Count; $i++) {
        if ((LastIn $days[$i].regular) -ge 0) { $lastRegular = $i }
    }

    function OfficialClose($Index) {
        if ($null -eq $Index -or $Index -lt 0 -or $Index -ge $days.Count) { return $null }
        if ($Index -eq $lastRegular -and $marketTime -ge $days[$Index].regular[0]) { return $price }
        if ($null -ne $lastRegular -and $Index -eq ($lastRegular - 1) -and $previousClose) { return $previousClose }
        $idx = LastIn $days[$Index].regular
        if ($idx -ge 0) { return $closes[$idx] }
        return $null
    }

    $preMove = $null; $postMove = $null
    $hasExt = [bool]$meta.hasPrePostMarketData -and $meta.instrumentType -ne 'CRYPTOCURRENCY'
    if ($hasExt -and $null -ne $current) {
        $idx = LastIn $days[$current].pre
        if ($idx -ge 0) { $preMove = New-Move $closes[$idx] (OfficialClose ($current - 1)) $times[$idx] }
        # Before today's after-hours session has traded, show the most recent one.
        foreach ($d in @($current, ($current - 1))) {
            if ($d -lt 0) { continue }
            $idx = LastIn $days[$d].post
            if ($idx -ge 0) {
                $postMove = New-Move $closes[$idx] (OfficialClose $d) $times[$idx]
                break
            }
        }
    }

    $regularBase = if ($lastRegular) { OfficialClose ($lastRegular - 1) } else { $previousClose }
    $regularMove = New-Move $price $regularBase $marketTime

    $session = 'closed'
    foreach ($name in 'pre', 'regular', 'post') {
        $w = $meta.currentTradingPeriod.$name
        if ($w -and $w.start -le $now -and $now -lt $w.end) { $session = $name }
    }

    $points = New-Object Collections.ArrayList
    $bands = @{}
    if ($null -ne $current) {
        $day = $days[$current]
        $from = Get-LowerBound $times ([long](StartOf $day))
        $to = Get-LowerBound $times ([long](EndOf $day))
        if ($from -ge $to -and $current -gt 0) {  # today has no prints yet: chart the last active day
            $day = $days[$current - 1]
            $from = Get-LowerBound $times ([long](StartOf $day))
            $to = Get-LowerBound $times ([long](EndOf $day))
        }
        $step = [math]::Max(1, [int][math]::Floor(($to - $from) / $MaxChartPoints))
        for ($i = $from; $i -lt $to; $i += $step) {
            [void]$points.Add(@($times[$i], [math]::Round($closes[$i], 4)))
        }
        if ($to -gt $from -and (($to - 1 - $from) % $step) -ne 0) {
            [void]$points.Add(@($times[$to - 1], [math]::Round($closes[$to - 1], 4)))
        }
        $bands = $day
    }

    $name = if ($meta.longName) { $meta.longName } elseif ($meta.shortName) { $meta.shortName } else { $Symbol }
    $exchange = if ($meta.fullExchangeName) { $meta.fullExchangeName } elseif ($meta.exchangeName) { $meta.exchangeName } else { '' }
    $result = @{
        symbol         = $Symbol
        name           = $name
        exchange       = $exchange
        currency       = [string]$meta.currency
        type           = [string]$meta.instrumentType
        timezone       = if ($meta.exchangeTimezoneName) { $meta.exchangeTimezoneName } else { 'America/New_York' }
        has_ext        = $hasExt
        session        = $session
        regular        = $regularMove
        pre            = $preMove
        post           = $postMove
        previous_close = $regularBase
        day_high       = $meta.regularMarketDayHigh
        day_low        = $meta.regularMarketDayLow
        year_high      = $meta.fiftyTwoWeekHigh
        year_low       = $meta.fiftyTwoWeekLow
        volume         = $meta.regularMarketVolume
        periods        = $meta.currentTradingPeriod
        chart          = @{ points = $points; bands = $bands }
        stale          = $false
    }
    return ConvertTo-Json $result -Depth 6 -Compress
}

# Returns symbol -> @{ Json = text } or @{ NotFound = $true } or @{ Error = text }.
function Get-QuoteResults([string[]]$Symbols) {
    $results = @{}
    $now = Get-Now
    $tasks = @{}
    foreach ($s in $Symbols) {
        $hit = $Cache[$s]
        if ($hit -and ($now - $hit.At) -lt $CacheTtl) { $results[$s] = @{ Json = $hit.Json } }
        elseif (-not $tasks.ContainsKey($s)) {
            $tasks[$s] = $Client.GetAsync(($ChartUrl -f [Uri]::EscapeDataString($s)))
        }
    }
    # Requests run at the same time; PowerShell only waits for them and parses the answers.
    foreach ($s in $tasks.Keys) {
        $outcome = $null
        try {
            $response = $tasks[$s].GetAwaiter().GetResult()
            if ([int]$response.StatusCode -eq 404) { $outcome = @{ NotFound = $true } }
            elseif (-not $response.IsSuccessStatusCode) { $outcome = @{ Error = "Yahoo returned HTTP $([int]$response.StatusCode)" } }
            else {
                $parsed = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
                $raw = @($parsed.chart.result)[0]
                if ($null -eq $raw) { $outcome = @{ NotFound = $true } }
                else {
                    $json = Build-QuoteJson $s $raw
                    $Cache[$s] = @{ At = (Get-Now); Json = $json }
                    $outcome = @{ Json = $json }
                }
            }
        } catch {
            $outcome = @{ Error = "Could not read quote: $($_.Exception.Message)" }
        }
        # A brief Yahoo failure should not blank a card that has data.
        if ($outcome.Error -and $Cache[$s]) {
            Write-Warning "Serving stale ${s}: $($outcome.Error)"
            $outcome = @{ Json = $Cache[$s].Json.Replace('"stale":false', '"stale":true') }
        }
        $results[$s] = $outcome
    }
    return $results
}

function Get-QuoteText($Symbol, $Outcome) {
    if ($Outcome.Json) { return $Outcome.Json }
    $message = if ($Outcome.NotFound) { 'No data found for this ticker' } else { $Outcome.Error }
    return ConvertTo-Json @{ symbol = $Symbol; error = $message } -Compress
}

# ------------------------------------------------------------------- HTTP
function Send-Bytes($Context, [int]$Status, [string]$Type, [byte[]]$Bytes) {
    $res = $Context.Response
    $res.StatusCode = $Status
    $res.ContentType = $Type
    $res.ContentLength64 = $Bytes.Length
    $res.OutputStream.Write($Bytes, 0, $Bytes.Length)
    $res.OutputStream.Close()
}
function Send-Text($Context, [int]$Status, [string]$Json) {
    Send-Bytes $Context $Status 'application/json' ([Text.Encoding]::UTF8.GetBytes($Json))
}
function Send-Error($Context, [int]$Status, [string]$Message) {
    Send-Text $Context $Status (ConvertTo-Json @{ error = $Message } -Compress)
}
function ConvertTo-TickerJson($Tickers) { ConvertTo-Json @(, @($Tickers)) -Compress -Depth 3 | ForEach-Object { $_.Substring(1, $_.Length - 2) } }

# Refuses non-JSON bodies, so a form on another site cannot change the list.
function Read-JsonBody($Context) {
    if ($Context.Request.ContentType -notlike 'application/json*') {
        Send-Error $Context 415 'Expected a JSON body'
        return $null
    }
    $reader = New-Object IO.StreamReader($Context.Request.InputStream, [Text.Encoding]::UTF8)
    $parsed = $null
    try { $parsed = $reader.ReadToEnd() | ConvertFrom-Json } catch { }
    if ($null -eq $parsed) { Send-Error $Context 400 'Invalid JSON' }
    return $parsed
}

# AURORA_LISTEN_ALL opens the socket wider, so requests are held to localhost here too.
function Test-LocalRequest($Request) {
    [Net.IPAddress]::IsLoopback($Request.RemoteEndPoint.Address) -and $Request.Url.Host -in 'localhost', '127.0.0.1'
}

function Invoke-Route($Context) {
    if (-not (Test-LocalRequest $Context.Request)) { Send-Error $Context 403 'Local requests only'; return }
    $method = $Context.Request.HttpMethod
    $path = $Context.Request.Url.AbsolutePath

    if ($method -eq 'GET' -and $StaticFiles.ContainsKey($path)) {
        $file = $StaticFiles[$path]
        Send-Bytes $Context 200 $file[1] ([IO.File]::ReadAllBytes((Join-Path $WebDir $file[0])))
        return
    }
    if ($path -eq '/api/quotes' -and $method -eq 'GET') {
        $tickers = @(Get-Tickers)
        $all = @($tickers) + $Indexes
        $results = Get-QuoteResults $all
        $quotes = @($tickers | ForEach-Object { Get-QuoteText $_ $results[$_] }) -join ','
        $idx = @($Indexes | ForEach-Object { Get-QuoteText $_ $results[$_] }) -join ','
        $time = (Get-Now).ToString([Globalization.CultureInfo]::InvariantCulture)
        Send-Text $Context 200 ('{"quotes":[' + $quotes + '],"indexes":[' + $idx + '],"server_time":' + $time + '}')
        return
    }
    if ($path -eq '/api/watchlist' -and $method -eq 'POST') {
        $body = Read-JsonBody $Context
        if ($null -eq $body) { return }  # already answered
        $symbol = ConvertTo-Ticker $body.symbol
        if (-not $symbol) { Send-Error $Context 400 "That doesn't look like a ticker symbol"; return }
        $tickers = @(Get-Tickers)
        if ($tickers -ccontains $symbol) { Send-Error $Context 409 "$symbol is already on your watchlist"; return }
        $outcome = (Get-QuoteResults @($symbol))[$symbol]
        if ($outcome.NotFound) { Send-Error $Context 404 "Couldn't find a ticker called $symbol"; return }
        if ($outcome.Error) { Send-Error $Context 502 "Quote service is unavailable, so the ticker couldn't be checked"; return }
        $tickers = @($tickers) + $symbol
        Save-Tickers $tickers
        Send-Text $Context 201 ('{"quote":' + $outcome.Json + ',"tickers":' + (ConvertTo-TickerJson $tickers) + '}')
        return
    }
    if ($path -eq '/api/watchlist' -and $method -eq 'PUT') {
        $body = Read-JsonBody $Context
        if ($null -eq $body) { return }  # already answered
        if ($body.tickers -isnot [array]) { Send-Error $Context 400 'Expected a list of tickers'; return }
        $tickers = @(Get-Tickers)
        $ordered = New-Object Collections.ArrayList
        foreach ($t in $body.tickers) {
            $symbol = ConvertTo-Ticker $t
            if ($symbol -and $tickers -ccontains $symbol -and -not $ordered.Contains($symbol)) { [void]$ordered.Add($symbol) }
        }
        foreach ($t in $tickers) { if (-not $ordered.Contains($t)) { [void]$ordered.Add($t) } }
        Save-Tickers $ordered.ToArray()
        Send-Text $Context 200 ('{"tickers":' + (ConvertTo-TickerJson $ordered.ToArray()) + '}')
        return
    }
    if ($path -like '/api/watchlist/*' -and $method -eq 'DELETE') {
        $symbol = ConvertTo-Ticker ([Uri]::UnescapeDataString($Context.Request.Url.AbsolutePath.Substring('/api/watchlist/'.Length)))
        $tickers = @(Get-Tickers)
        if (-not $symbol -or $tickers -cnotcontains $symbol) { Send-Error $Context 404 "That ticker isn't on your watchlist"; return }
        $tickers = @($tickers | Where-Object { $_ -cne $symbol })
        Save-Tickers $tickers
        Send-Text $Context 200 ('{"tickers":' + (ConvertTo-TickerJson $tickers) + '}')
        return
    }
    if ($path -eq '/api/search' -and $method -eq 'GET') {
        $term = ([string]$Context.Request.QueryString['q']).Trim()
        if ($term.Length -gt 40) { $term = $term.Substring(0, 40) }
        $rows = @()
        if ($term) {
            # Suggestions are optional; typing a ticker still works if this fails.
            try {
                $text = $Client.GetStringAsync(($SearchUrl -f [Uri]::EscapeDataString($term))).GetAwaiter().GetResult()
                $rows = @(($text | ConvertFrom-Json).quotes | Where-Object { $_.symbol -and (ConvertTo-Ticker $_.symbol) } | ForEach-Object {
                    @{
                        symbol   = $_.symbol
                        name     = if ($_.shortname) { $_.shortname } elseif ($_.longname) { $_.longname } else { '' }
                        exchange = [string]$_.exchDisp
                    }
                })
            } catch { $rows = @() }
        }
        $json = @($rows | ForEach-Object { ConvertTo-Json $_ -Compress }) -join ','
        Send-Text $Context 200 ('{"results":[' + $json + ']}')
        return
    }
    Send-Error $Context 404 'Not found'
}

# ------------------------------------------------------------------- main
# Listens on localhost only: the app has no login and can change the local config file.
# On Linux a localhost prefix binds only [::1], but the dev container's port forward
# connects to 127.0.0.1, so there AURORA_LISTEN_ALL binds wider and Test-LocalRequest filters.
$Listener = $null
$first = if ($env:PORT) { [int]$env:PORT } else { 5000 }
$listenHost = if ($env:AURORA_LISTEN_ALL) { '+' } else { 'localhost' }
for ($port = $first; $port -lt ($first + 10); $port++) {
    $candidate = New-Object Net.HttpListener
    $candidate.Prefixes.Add("http://${listenHost}:$port/")
    try { $candidate.Start(); $Listener = $candidate; break }
    catch { $candidate.Close() }
}
if (-not $Listener) { throw "No free port between $first and $($first + 9)." }

$address = "http://localhost:$port/"
Write-Host ''
Write-Host "  Aurora Watch is running at $address" -ForegroundColor Cyan
Write-Host '  Close this window to stop it.'
Write-Host ''
if (-not $env:AURORA_NO_BROWSER) { Start-Process $address }

try {
    while ($Listener.IsListening) {
        $pending = $Listener.GetContextAsync()
        while (-not $pending.Wait(250)) { }  # short waits keep Ctrl+C working
        $context = $pending.Result
        try {
            Invoke-Route $context
        } catch {
            Write-Warning "$($context.Request.HttpMethod) $($context.Request.RawUrl): $($_.Exception.Message)"
            try { Send-Error $context 500 'Something went wrong' } catch { }
        }
    }
} finally {
    $Listener.Close()
}
