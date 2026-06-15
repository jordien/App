const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ================= CONFIGURACIÓN DE ETHEREAL EMAIL =================
const transporter = nodemailer.createTransport({
    host: 'smtp.ethereal.email',
    port: 587,
    secure: false,
    auth: {
        user: 'jerrold.spinka@ethereal.email',
        pass: '7yv47d4b6Nw9KxDPhg'
    }
});

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
    crearTablas();
});

function crearTablas() {
    db.query(`
        CREATE TABLE IF NOT EXISTS trabajador_recuperacion_tokens (
            id INT AUTO_INCREMENT PRIMARY KEY,
            id_trabajador INT NOT NULL,
            token VARCHAR(255) NOT NULL,
            expira_en DATETIME NOT NULL,
            usado TINYINT DEFAULT 0
        )
    `);
}

const SECRET_KEY = 'chepita_secret_key_2025';
const resetTokens = {};

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

// ================= RECUPERACIÓN ADMIN =================
app.post('/api/admin/recuperar-email', (req, res) => {
    const { email } = req.body;
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    
    if (!email) {
        return res.status(400).json({ success: false, message: 'Ingresa tu correo electrónico' });
    }
    
    db.query(`SELECT usuario FROM usuarios_admin WHERE email = ?`, [email], (err, results) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Error en el servidor' });
        }
        
        if (results.length === 0) {
            return res.json({ success: false, message: 'No existe una cuenta con ese correo electrónico' });
        }
        
        const { usuario } = results[0];
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + 3600000;
        resetTokens[token] = { email, expiresAt };
        const resetLink = `${baseUrl}/reset-password.html?token=${token}&tipo=admin`;
        
        const mailOptions = {
            from: 'Chepita App <no-reply@chepita.com>',
            to: email,
            subject: 'Recuperación de Contraseña - Chepita',
            html: `
                <div style="font-family: Arial; border: 2px solid #A63C89; padding: 20px; border-radius: 10px;">
                    <h2 style="color: #A63C89;">Recuperación de Contraseña</h2>
                    <p>Hola <strong>${usuario}</strong>,</p>
                    <p>Haz clic en el botón para restablecer tu contraseña:</p>
                    <div style="text-align: center; margin: 25px 0;">
                        <a href="${resetLink}" style="background:#A63C89; color:white; padding:12px 24px; text-decoration:none; border-radius:5px;">Restablecer Contraseña</a>
                    </div>
                    <p>Este enlace es válido por 1 hora.</p>
                    <p>Si no solicitaste este cambio, ignora este correo.</p>
                </div>
            `
        };
        
        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.error('Error email:', error);
                return res.status(500).json({ success: false, message: 'Error al enviar el correo.' });
            }
            console.log('✅ Email enviado a:', email);
            console.log('📧 Ver correo en:', nodemailer.getTestMessageUrl(info));
            res.json({ success: true, message: 'Correo enviado. Revisa la consola para ver el enlace de vista previa.' });
        });
    });
});

app.get('/api/admin/verificar-token-recuperacion/:token', (req, res) => {
    const { token } = req.params;
    const tokenData = resetTokens[token];
    
    if (!tokenData || Date.now() > tokenData.expiresAt) {
        return res.status(400).json({ valido: false, message: 'El enlace ha expirado' });
    }
    res.json({ valido: true });
});

app.post('/api/admin/reset-password', (req, res) => {
    const { token, nuevaPassword } = req.body;
    
    if (!nuevaPassword || nuevaPassword.length < 8) {
        return res.status(400).json({ success: false, message: "La contraseña debe tener al menos 8 caracteres" });
    }
    
    const tokenData = resetTokens[token];
    if (!tokenData || Date.now() > tokenData.expiresAt) {
        return res.status(400).json({ success: false, message: "El enlace ha expirado" });
    }
    
    const hashedPassword = bcrypt.hashSync(nuevaPassword, 10);
    db.query(`UPDATE usuarios_admin SET password = ? WHERE email = ?`, [hashedPassword, tokenData.email], (err) => {
        if (err) return res.status(500).json({ success: false, message: "Error actualizando" });
        delete resetTokens[token];
        res.json({ success: true, message: "Contraseña actualizada correctamente" });
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

// ================= RECUPERACIÓN TRABAJADOR =================
app.post('/api/trabajadores/recuperar-password', (req, res) => {
    const { email } = req.body;
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    
    if (!email) {
        return res.status(400).json({ success: false, message: 'Ingresa tu correo electrónico' });
    }
    
    db.query(`SELECT Id_Trabajador, NombreCompleto, email FROM trabajadores WHERE email = ? AND Activo = 1`, [email], (err, results) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Error en el servidor' });
        }
        
        if (results.length === 0) {
            return res.json({ success: false, message: 'No existe una cuenta activa con ese correo electrónico' });
        }
        
        const trabajador = results[0];
        const token = crypto.randomBytes(32).toString('hex');
        const expiraEn = new Date();
        expiraEn.setHours(expiraEn.getHours() + 1);
        
        db.query(`INSERT INTO trabajador_recuperacion_tokens (id_trabajador, token, expira_en) VALUES (?, ?, ?)`, 
            [trabajador.Id_Trabajador, token, expiraEn], (err) => {
            if (err) {
                return res.status(500).json({ success: false, message: 'Error en el servidor' });
            }
            
            const resetLink = `${baseUrl}/reset-password.html?token=${token}&tipo=trabajador`;
            
            const mailOptions = {
                from: 'Chepita App <no-reply@chepita.com>',
                to: trabajador.email,
                subject: 'Recuperación de Contraseña - Chepita',
                html: `
                    <div style="font-family: Arial; border: 2px solid #A63C89; padding: 20px; border-radius: 10px;">
                        <h2 style="color: #A63C89;">Recuperación de Contraseña</h2>
                        <p>Hola <strong>${trabajador.NombreCompleto}</strong>,</p>
                        <p>Haz clic en el botón para restablecer tu contraseña:</p>
                        <div style="text-align: center; margin: 25px 0;">
                            <a href="${resetLink}" style="background:#A63C89; color:white; padding:12px 24px; text-decoration:none; border-radius:5px;">Restablecer Contraseña</a>
                        </div>
                        <p>Este enlace es válido por 1 hora.</p>
                        <p>Si no solicitaste este cambio, ignora este correo.</p>
                    </div>
                `
            };
            
            transporter.sendMail(mailOptions, (error, info) => {
                if (error) {
                    console.error('Error email:', error);
                    return res.status(500).json({ success: false, message: 'Error al enviar el correo.' });
                }
                console.log('✅ Email enviado a:', trabajador.email);
                console.log('📧 Ver correo en:', nodemailer.getTestMessageUrl(info));
                res.json({ success: true, message: 'Correo enviado. Revisa la consola para ver el enlace de vista previa.' });
            });
        });
    });
});

app.get('/api/trabajadores/verificar-token-recuperacion/:token', (req, res) => {
    const { token } = req.params;
    
    db.query(`
        SELECT tr.id_trabajador, t.NombreCompleto, t.email
        FROM trabajador_recuperacion_tokens tr
        JOIN trabajadores t ON tr.id_trabajador = t.Id_Trabajador
        WHERE tr.token = ? AND tr.usado = 0 AND tr.expira_en > NOW()
    `, [token], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) {
            return res.status(400).json({ valido: false, message: 'El enlace ha expirado' });
        }
        res.json({
            valido: true,
            id_trabajador: results[0].id_trabajador,
            nombre: results[0].NombreCompleto,
            email: results[0].email
        });
    });
});

app.post('/api/trabajadores/restablecer-password', async (req, res) => {
    const { token, nueva_password } = req.body;
    
    if (!nueva_password || nueva_password.length < 4) {
        return res.status(400).json({ success: false, message: 'La contraseña debe tener al menos 4 caracteres' });
    }
    
    db.query(`SELECT id_trabajador FROM trabajador_recuperacion_tokens WHERE token = ? AND usado = 0 AND expira_en > NOW()`, [token], async (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Error en el servidor' });
        if (results.length === 0) {
            return res.status(400).json({ success: false, message: 'El enlace ha expirado' });
        }
        
        const idTrabajador = results[0].id_trabajador;
        const hashedPassword = await bcrypt.hash(nueva_password, 10);
        
        db.query(`UPDATE trabajadores SET password_hash = ?, debe_cambiar_password = 0 WHERE Id_Trabajador = ?`, [hashedPassword, idTrabajador], (err) => {
            if (err) return res.status(500).json({ success: false, message: 'Error actualizando' });
            
            db.query(`UPDATE trabajador_recuperacion_tokens SET usado = 1 WHERE token = ?`, [token], (err) => {
                if (err) return res.status(500).json({ success: false, message: 'Error actualizando token' });
                res.json({ success: true, message: 'Contraseña restablecida correctamente' });
            });
        });
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

app.get('/reset-password.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'reset-password.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor Chepita corriendo en puerto ${PORT}`);
});