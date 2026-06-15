const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Conexión a MySQL (Railway)
const db = mysql.createConnection({
    host: process.env.MYSQLHOST || 'acela.proxy.rlwy.net',
    user: process.env.MYSQLUSER || 'root',
    password: process.env.MYSQLPASSWORD || 'MFaPbrOIWcBNrrvrxBNcfClvNNtFIoSt',
    database: process.env.MYSQLDATABASE || 'railway',
    port: process.env.MYSQLPORT || 49485
});

db.connect(err => {
    if (err) {
        console.error('❌ Error de conexión:', err);
        return;
    }
    console.log('✅ Conectado a MySQL en Railway');
});

const SECRET_KEY = 'chepita_secret_key_2025';

// ================= LOGIN ADMIN =================
app.post('/api/admin/login', async (req, res) => {
    const { usuario, password } = req.body;
    
    db.query(`SELECT * FROM usuarios_admin WHERE usuario = ?`, [usuario], async (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) {
            return res.status(401).json({ success: false, message: "Usuario o contraseña incorrectos" });
        }
        
        const admin = results[0];
        let passwordValida = false;
        
        if (admin.password && admin.password.startsWith('$2b$')) {
            passwordValida = await bcrypt.compare(password, admin.password);
        }
        
        if (passwordValida) {
            const token = jwt.sign(
                { id: admin.id, usuario: admin.usuario, rol: 'admin' },
                SECRET_KEY,
                { expiresIn: '8h' }
            );
            return res.json({ success: true, token: token, user: admin.usuario });
        }
        
        res.status(401).json({ success: false, message: "Contraseña incorrecta" });
    });
});

// ================= LOGIN TRABAJADOR =================
app.post('/api/trabajadores/login', async (req, res) => {
    const { nombre_usuario, password } = req.body;
    
    db.query(`SELECT * FROM trabajadores WHERE (nombre_usuario = ? OR email = ?) AND Activo = 1`, 
        [nombre_usuario, nombre_usuario], async (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) {
            return res.status(401).json({ success: false, message: "Usuario o contraseña incorrectos" });
        }
        
        const trabajador = results[0];
        let passwordValida = false;
        
        const md5pass = crypto.createHash('md5').update(password).digest('hex');
        if (trabajador.password_hash === md5pass) {
            passwordValida = true;
        }
        
        if (!passwordValida && trabajador.password_hash && trabajador.password_hash.startsWith('$2b$')) {
            passwordValida = await bcrypt.compare(password, trabajador.password_hash);
        }
        
        if (passwordValida) {
            const token = jwt.sign(
                { id: trabajador.Id_Trabajador, nombre: trabajador.NombreCompleto, rol: 'trabajador' },
                SECRET_KEY,
                { expiresIn: '8h' }
            );
            return res.json({
                success: true,
                token: token,
                trabajador: {
                    id: trabajador.Id_Trabajador,
                    nombre: trabajador.NombreCompleto,
                    email: trabajador.email,
                    usuario: trabajador.nombre_usuario
                }
            });
        }
        
        res.status(401).json({ success: false, message: "Contraseña incorrecta" });
    });
});

// ================= VERIFICAR SESIÓN =================
app.get('/api/verificar-sesion', (req, res) => {
    const token = req.headers['x-auth-token'];
    if (!token) return res.status(401).json({ autenticado: false });
    
    jwt.verify(token, SECRET_KEY, (err, decoded) => {
        if (err) return res.status(403).json({ autenticado: false });
        res.json({ autenticado: true, usuario: decoded });
    });
});

// ================= PRODUCTOS =================
app.get('/api/productos', (req, res) => {
    db.query(`
        SELECT p.Id_Producto, p.Nombre, p.Precio, p.Marca,
               COALESCE(SUM(s.Cantidad), 0) AS Stock
        FROM producto p
        LEFT JOIN stock s ON p.Id_Producto = s.Id_Producto
        GROUP BY p.Id_Producto
        ORDER BY p.Id_Producto DESC
    `, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/productos/bajo-stock', (req, res) => {
    db.query(`
        SELECT p.Id_Producto, p.Nombre, p.Precio, COALESCE(SUM(s.Cantidad), 0) AS Stock
        FROM producto p
        LEFT JOIN stock s ON p.Id_Producto = s.Id_Producto
        GROUP BY p.Id_Producto
        HAVING Stock < 10
    `, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// ================= CATEGORÍAS =================
app.get('/api/categorias', (req, res) => {
    db.query(`SELECT Id_Categoria, Nombre FROM categoria ORDER BY Nombre`, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// ================= PROVEEDORES =================
app.get('/api/proveedores', (req, res) => {
    db.query(`SELECT Id_Proveedor, Nombre, Empresa FROM proveedores ORDER BY Nombre`, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// ================= TRABAJADORES =================
app.get('/api/trabajadores', (req, res) => {
    db.query(`SELECT Id_Trabajador, NombreCompleto, Celular, Activo, email, nombre_usuario FROM trabajadores`, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/trabajadores/activos', (req, res) => {
    db.query(`SELECT Id_Trabajador, NombreCompleto FROM trabajadores WHERE Activo = 1`, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.post('/api/trabajadores', async (req, res) => {
    const { NombreCompleto, Celular, email, Activo, Salario } = req.body;
    
    if (!NombreCompleto || !Celular || !email) {
        return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }
    
    const nombreUsuario = NombreCompleto.toLowerCase().replace(/ /g, '.');
    const md5pass = crypto.createHash('md5').update('1234').digest('hex');
    
    db.query(`INSERT INTO trabajadores (NombreCompleto, Celular, email, Activo, Salario, nombre_usuario, password_hash, debe_cambiar_password) 
              VALUES (?, ?, ?, ?, ?, ?, ?, 1)`, 
        [NombreCompleto, Celular, email, Activo !== undefined ? Activo : 1, Salario || null, nombreUsuario, md5pass], 
        (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: "Trabajador registrado", Id_Trabajador: result.insertId });
        });
});

// ================= ESTADÍSTICAS =================
app.get('/api/estadisticas-ventas', (req, res) => {
    db.query(`
        SELECT 
            COALESCE(SUM(CASE WHEN DATE(Fecha) = CURDATE() THEN Monto ELSE 0 END), 0) as total_hoy,
            COALESCE(SUM(CASE WHEN YEAR(Fecha) = YEAR(CURDATE()) AND MONTH(Fecha) = MONTH(CURDATE()) THEN Monto ELSE 0 END), 0) as total_mes
        FROM compra
    `, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results[0]);
    });
});

app.get('/api/top-productos', (req, res) => {
    db.query(`
        SELECT p.Nombre, SUM(o.CantidadVendida) as cantidad
        FROM orden o
        JOIN producto p ON o.Id_Producto = p.Id_Producto
        GROUP BY p.Id_Producto
        ORDER BY cantidad DESC
        LIMIT 5
    `, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/puntos-vendedores', (req, res) => {
    db.query(`
        SELECT t.NombreCompleto as nombre_completo, COUNT(c.Num_Factura) as total_ventas,
               ROUND(COUNT(c.Num_Factura) * 10, 2) as puntaje_total
        FROM compra c
        JOIN trabajadores t ON c.Id_Vendedor = t.Id_Trabajador
        GROUP BY t.Id_Trabajador
        ORDER BY puntaje_total DESC
    `, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/ventas-recientes', (req, res) => {
    db.query(`
        SELECT c.Fecha, c.Monto as Subtotal,
               CONCAT(COALESCE(cl.Nombre, 'Cliente'), ' ', COALESCE(cl.Apellido, '')) as cliente,
               p.Nombre as producto, o.CantidadVendida as cantidad
        FROM compra c
        LEFT JOIN clientes cl ON c.Id_cliente = cl.Id_cliente
        LEFT JOIN orden o ON c.Num_Factura = o.NumFactura
        LEFT JOIN producto p ON o.Id_Producto = p.Id_Producto
        ORDER BY c.Fecha DESC
        LIMIT 10
    `, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// ================= RUTAS PRINCIPALES =================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor Chepita corriendo en puerto ${PORT}`);
});