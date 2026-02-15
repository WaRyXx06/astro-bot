module.exports = {
  apps: [{
    name: 'presecop-mirror',
    script: 'index.js',
    
    // Production settings
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    
    // Environment
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    
    // Logs
    log_file: './logs/combined.log',
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    
    // Advanced settings
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 10000,
    
    // Auto-restart on crashes
    min_uptime: '10s',
    max_restarts: 5,
    
    // Cron restart (optional - restart every day at 3AM)
    cron_restart: '0 3 * * *',
    
    // Ignore watch (for production)
    ignore_watch: [
      'node_modules',
      'logs',
      'temp',
      '*.log'
    ]
  }]
}; 